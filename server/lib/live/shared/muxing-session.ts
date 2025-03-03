
import { mapSeries } from 'bluebird'
import { FSWatcher, watch } from 'chokidar'
import { FfmpegCommand } from 'fluent-ffmpeg'
import { appendFile, ensureDir, readFile, stat } from 'fs-extra'
import { basename, join } from 'path'
import { EventEmitter } from 'stream'
import { getLiveMuxingCommand, getLiveTranscodingCommand } from '@server/helpers/ffmpeg'
import { logger, loggerTagsFactory, LoggerTagsFn } from '@server/helpers/logger'
import { CONFIG } from '@server/initializers/config'
import { MEMOIZE_TTL, VIDEO_LIVE } from '@server/initializers/constants'
import { VideoFileModel } from '@server/models/video/video-file'
import { MStreamingPlaylistVideo, MUserId, MVideoLiveVideo } from '@server/types/models'
import { getLiveDirectory, getLiveReplayBaseDirectory } from '../../paths'
import { VideoTranscodingProfilesManager } from '../../transcoding/default-transcoding-profiles'
import { isAbleToUploadVideo } from '../../user'
import { LiveQuotaStore } from '../live-quota-store'
import { LiveSegmentShaStore } from '../live-segment-sha-store'
import { buildConcatenatedName } from '../live-utils'

import memoizee = require('memoizee')

interface MuxingSessionEvents {
  'master-playlist-created': ({ videoId: number }) => void

  'bad-socket-health': ({ videoId: number }) => void
  'duration-exceeded': ({ videoId: number }) => void
  'quota-exceeded': ({ videoId: number }) => void

  'ffmpeg-end': ({ videoId: number }) => void
  'ffmpeg-error': ({ videoId: string }) => void

  'after-cleanup': ({ videoId: number }) => void
}

declare interface MuxingSession {
  on<U extends keyof MuxingSessionEvents>(
    event: U, listener: MuxingSessionEvents[U]
  ): this

  emit<U extends keyof MuxingSessionEvents>(
    event: U, ...args: Parameters<MuxingSessionEvents[U]>
  ): boolean
}

class MuxingSession extends EventEmitter {

  private ffmpegCommand: FfmpegCommand

  private readonly context: any
  private readonly user: MUserId
  private readonly sessionId: string
  private readonly videoLive: MVideoLiveVideo
  private readonly streamingPlaylist: MStreamingPlaylistVideo
  private readonly inputUrl: string
  private readonly fps: number
  private readonly allResolutions: number[]

  private readonly bitrate: number
  private readonly ratio: number

  private readonly videoId: number
  private readonly videoUUID: string
  private readonly saveReplay: boolean

  private readonly outDirectory: string
  private readonly replayDirectory: string

  private readonly lTags: LoggerTagsFn

  private segmentsToProcessPerPlaylist: { [playlistId: string]: string[] } = {}

  private tsWatcher: FSWatcher
  private masterWatcher: FSWatcher

  private aborted = false

  private readonly isAbleToUploadVideoWithCache = memoizee((userId: number) => {
    return isAbleToUploadVideo(userId, 1000)
  }, { maxAge: MEMOIZE_TTL.LIVE_ABLE_TO_UPLOAD })

  private readonly hasClientSocketInBadHealthWithCache = memoizee((sessionId: string) => {
    return this.hasClientSocketInBadHealth(sessionId)
  }, { maxAge: MEMOIZE_TTL.LIVE_CHECK_SOCKET_HEALTH })

  constructor (options: {
    context: any
    user: MUserId
    sessionId: string
    videoLive: MVideoLiveVideo
    streamingPlaylist: MStreamingPlaylistVideo
    inputUrl: string
    fps: number
    bitrate: number
    ratio: number
    allResolutions: number[]
  }) {
    super()

    this.context = options.context
    this.user = options.user
    this.sessionId = options.sessionId
    this.videoLive = options.videoLive
    this.streamingPlaylist = options.streamingPlaylist
    this.inputUrl = options.inputUrl
    this.fps = options.fps

    this.bitrate = options.bitrate
    this.ratio = options.ratio

    this.allResolutions = options.allResolutions

    this.videoId = this.videoLive.Video.id
    this.videoUUID = this.videoLive.Video.uuid

    this.saveReplay = this.videoLive.saveReplay

    this.outDirectory = getLiveDirectory(this.videoLive.Video)
    this.replayDirectory = join(getLiveReplayBaseDirectory(this.videoLive.Video), new Date().toISOString())

    this.lTags = loggerTagsFactory('live', this.sessionId, this.videoUUID)
  }

  async runMuxing () {
    this.createFiles()

    await this.prepareDirectories()

    this.ffmpegCommand = CONFIG.LIVE.TRANSCODING.ENABLED
      ? await getLiveTranscodingCommand({
        inputUrl: this.inputUrl,

        outPath: this.outDirectory,
        masterPlaylistName: this.streamingPlaylist.playlistFilename,

        latencyMode: this.videoLive.latencyMode,

        resolutions: this.allResolutions,
        fps: this.fps,
        bitrate: this.bitrate,
        ratio: this.ratio,

        availableEncoders: VideoTranscodingProfilesManager.Instance.getAvailableEncoders(),
        profile: CONFIG.LIVE.TRANSCODING.PROFILE
      })
      : getLiveMuxingCommand({
        inputUrl: this.inputUrl,
        outPath: this.outDirectory,
        masterPlaylistName: this.streamingPlaylist.playlistFilename,
        latencyMode: this.videoLive.latencyMode
      })

    logger.info('Running live muxing/transcoding for %s.', this.videoUUID, this.lTags())

    this.watchTSFiles()
    this.watchMasterFile()

    let ffmpegShellCommand: string
    this.ffmpegCommand.on('start', cmdline => {
      ffmpegShellCommand = cmdline

      logger.debug('Running ffmpeg command for live', { ffmpegShellCommand, ...this.lTags() })
    })

    this.ffmpegCommand.on('error', (err, stdout, stderr) => {
      this.onFFmpegError({ err, stdout, stderr, ffmpegShellCommand })
    })

    this.ffmpegCommand.on('end', () => {
      this.emit('ffmpeg-end', ({ videoId: this.videoId }))

      this.onFFmpegEnded()
    })

    this.ffmpegCommand.run()
  }

  abort () {
    if (!this.ffmpegCommand) return

    this.aborted = true
    this.ffmpegCommand.kill('SIGINT')
  }

  destroy () {
    this.removeAllListeners()
    this.isAbleToUploadVideoWithCache.clear()
    this.hasClientSocketInBadHealthWithCache.clear()
  }

  private onFFmpegError (options: {
    err: any
    stdout: string
    stderr: string
    ffmpegShellCommand: string
  }) {
    const { err, stdout, stderr, ffmpegShellCommand } = options

    this.onFFmpegEnded()

    // Don't care that we killed the ffmpeg process
    if (err?.message?.includes('Exiting normally')) return

    logger.error('Live transcoding error.', { err, stdout, stderr, ffmpegShellCommand, ...this.lTags() })

    this.emit('ffmpeg-error', ({ videoId: this.videoId }))
  }

  private onFFmpegEnded () {
    logger.info('RTMP transmuxing for video %s ended. Scheduling cleanup', this.inputUrl, this.lTags())

    setTimeout(() => {
      // Wait latest segments generation, and close watchers

      Promise.all([ this.tsWatcher.close(), this.masterWatcher.close() ])
        .then(() => {
          // Process remaining segments hash
          for (const key of Object.keys(this.segmentsToProcessPerPlaylist)) {
            this.processSegments(this.segmentsToProcessPerPlaylist[key])
          }
        })
        .catch(err => {
          logger.error(
            'Cannot close watchers of %s or process remaining hash segments.', this.outDirectory,
            { err, ...this.lTags() }
          )
        })

      this.emit('after-cleanup', { videoId: this.videoId })
    }, 1000)
  }

  private watchMasterFile () {
    this.masterWatcher = watch(this.outDirectory + '/' + this.streamingPlaylist.playlistFilename)

    this.masterWatcher.on('add', () => {
      this.emit('master-playlist-created', { videoId: this.videoId })

      this.masterWatcher.close()
        .catch(err => logger.error('Cannot close master watcher of %s.', this.outDirectory, { err, ...this.lTags() }))
    })
  }

  private watchTSFiles () {
    const startStreamDateTime = new Date().getTime()

    this.tsWatcher = watch(this.outDirectory + '/*.ts')

    const playlistIdMatcher = /^([\d+])-/

    const addHandler = async (segmentPath: string) => {
      logger.debug('Live add handler of %s.', segmentPath, this.lTags())

      const playlistId = basename(segmentPath).match(playlistIdMatcher)[0]

      const segmentsToProcess = this.segmentsToProcessPerPlaylist[playlistId] || []
      this.processSegments(segmentsToProcess)

      this.segmentsToProcessPerPlaylist[playlistId] = [ segmentPath ]

      if (this.hasClientSocketInBadHealthWithCache(this.sessionId)) {
        this.emit('bad-socket-health', { videoId: this.videoId })
        return
      }

      // Duration constraint check
      if (this.isDurationConstraintValid(startStreamDateTime) !== true) {
        this.emit('duration-exceeded', { videoId: this.videoId })
        return
      }

      // Check user quota if the user enabled replay saving
      if (await this.isQuotaExceeded(segmentPath) === true) {
        this.emit('quota-exceeded', { videoId: this.videoId })
      }
    }

    const deleteHandler = (segmentPath: string) => LiveSegmentShaStore.Instance.removeSegmentSha(this.videoUUID, segmentPath)

    this.tsWatcher.on('add', p => addHandler(p))
    this.tsWatcher.on('unlink', p => deleteHandler(p))
  }

  private async isQuotaExceeded (segmentPath: string) {
    if (this.saveReplay !== true) return false
    if (this.aborted) return false

    try {
      const segmentStat = await stat(segmentPath)

      LiveQuotaStore.Instance.addQuotaTo(this.user.id, this.videoLive.id, segmentStat.size)

      const canUpload = await this.isAbleToUploadVideoWithCache(this.user.id)

      return canUpload !== true
    } catch (err) {
      logger.error('Cannot stat %s or check quota of %d.', segmentPath, this.user.id, { err, ...this.lTags() })
    }
  }

  private createFiles () {
    for (let i = 0; i < this.allResolutions.length; i++) {
      const resolution = this.allResolutions[i]

      const file = new VideoFileModel({
        resolution,
        size: -1,
        extname: '.ts',
        infoHash: null,
        fps: this.fps,
        videoStreamingPlaylistId: this.streamingPlaylist.id
      })

      VideoFileModel.customUpsert(file, 'streaming-playlist', null)
        .catch(err => logger.error('Cannot create file for live streaming.', { err, ...this.lTags() }))
    }
  }

  private async prepareDirectories () {
    await ensureDir(this.outDirectory)

    if (this.videoLive.saveReplay === true) {
      await ensureDir(this.replayDirectory)
    }
  }

  private isDurationConstraintValid (streamingStartTime: number) {
    const maxDuration = CONFIG.LIVE.MAX_DURATION
    // No limit
    if (maxDuration < 0) return true

    const now = new Date().getTime()
    const max = streamingStartTime + maxDuration

    return now <= max
  }

  private processSegments (segmentPaths: string[]) {
    mapSeries(segmentPaths, async previousSegment => {
      // Add sha hash of previous segments, because ffmpeg should have finished generating them
      await LiveSegmentShaStore.Instance.addSegmentSha(this.videoUUID, previousSegment)

      if (this.saveReplay) {
        await this.addSegmentToReplay(previousSegment)
      }
    }).catch(err => {
      if (this.aborted) return

      logger.error('Cannot process segments', { err, ...this.lTags() })
    })
  }

  private hasClientSocketInBadHealth (sessionId: string) {
    const rtmpSession = this.context.sessions.get(sessionId)

    if (!rtmpSession) {
      logger.warn('Cannot get session %s to check players socket health.', sessionId, this.lTags())
      return
    }

    for (const playerSessionId of rtmpSession.players) {
      const playerSession = this.context.sessions.get(playerSessionId)

      if (!playerSession) {
        logger.error('Cannot get player session %s to check socket health.', playerSession, this.lTags())
        continue
      }

      if (playerSession.socket.writableLength > VIDEO_LIVE.MAX_SOCKET_WAITING_DATA) {
        return true
      }
    }

    return false
  }

  private async addSegmentToReplay (segmentPath: string) {
    const segmentName = basename(segmentPath)
    const dest = join(this.replayDirectory, buildConcatenatedName(segmentName))

    try {
      const data = await readFile(segmentPath)

      await appendFile(dest, data)
    } catch (err) {
      logger.error('Cannot copy segment %s to replay directory.', segmentPath, { err, ...this.lTags() })
    }
  }
}

// ---------------------------------------------------------------------------

export {
  MuxingSession
}
