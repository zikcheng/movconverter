import type { ParsedMovie, ParsedTrack } from './box-reader'
import { UnsupportedFormatError } from './errors'

export type VideoAction = 'copy' | 'copy-retag' | 'wasm'
export type AudioAction = 'copy' | 'webcodecs' | 'wasm'
export type ConversionMethod = 'remux' | 'audio-transcode' | 'full-transcode'

export interface VideoTrackPlan {
  trackId: number
  format: string
  action: VideoAction
}

export interface AudioTrackPlan {
  trackId: number
  format: string
  action: AudioAction
}

export interface DroppedTrack {
  trackId: number
  handler: string
  format: string
}

export interface ConversionPlan {
  method: ConversionMethod
  video: VideoTrackPlan | null
  audio: AudioTrackPlan | null
  /** Tracks MP4 cannot carry (timecode, subtitles, extra streams). Dropped, not errored. */
  dropped: DroppedTrack[]
}

/** Video formats MP4 carries as-is. */
const VIDEO_COPY = new Set(['avc1', 'avc3', 'hvc1'])
/** HEVC packaging that must be re-tagged to hvc1 for Safari/QuickTime. */
const VIDEO_RETAG = new Set(['hev1'])
/** Audio formats MP4 carries as-is. */
const AUDIO_COPY = new Set(['mp4a'])
/** Uncompressed PCM variants: no decoder needed, encode to AAC via WebCodecs. */
const AUDIO_PCM = new Set(['sowt', 'twos', 'lpcm', 'in24', 'in32', 'raw ', 'NONE'])

function videoAction(track: ParsedTrack): VideoAction {
  const formats = track.stsdEntries.map((e) => e.format)
  if (formats.every((f) => VIDEO_COPY.has(f))) return 'copy'
  if (formats.every((f) => VIDEO_COPY.has(f) || VIDEO_RETAG.has(f))) return 'copy-retag'
  return 'wasm'
}

function audioAction(track: ParsedTrack): AudioAction {
  const formats = track.stsdEntries.map((e) => e.format)
  if (formats.every((f) => AUDIO_COPY.has(f))) return 'copy'
  if (formats.every((f) => AUDIO_PCM.has(f))) return 'webcodecs'
  return 'wasm'
}

function trackFormat(track: ParsedTrack): string {
  return track.stsdEntries[0]?.format ?? '????'
}

/**
 * Decide the cheapest conversion path for a parsed movie.
 *
 * The first video track and first audio track are converted; every other
 * track (timecode, subtitles, additional streams) is dropped and reported.
 */
export function inspect(movie: ParsedMovie): ConversionPlan {
  let video: VideoTrackPlan | null = null
  let audio: AudioTrackPlan | null = null
  const dropped: DroppedTrack[] = []

  for (const track of movie.tracks) {
    if (track.handler === 'vide' && video === null) {
      video = { trackId: track.trackId, format: trackFormat(track), action: videoAction(track) }
    } else if (track.handler === 'soun' && audio === null) {
      audio = { trackId: track.trackId, format: trackFormat(track), action: audioAction(track) }
    } else {
      dropped.push({ trackId: track.trackId, handler: track.handler, format: trackFormat(track) })
    }
  }

  if (video === null && audio === null) {
    throw new UnsupportedFormatError('file contains no audio or video tracks')
  }

  const videoCopyable = video === null || video.action !== 'wasm'
  const audioCopyable = audio === null || audio.action === 'copy'
  const audioWebcodecs = audio?.action === 'webcodecs'

  let method: ConversionMethod
  if (videoCopyable && audioCopyable) {
    method = 'remux'
  } else if (videoCopyable && audioWebcodecs) {
    method = 'audio-transcode'
  } else {
    method = 'full-transcode'
  }

  return { method, video, audio, dropped }
}
