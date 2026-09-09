import type { AacEncoder } from './aac'
import { audioTranscode } from './audio-path'
import { parseMovie } from './box-reader'
import { UnsupportedFormatError } from './errors'
import { type ConversionMethod, type ConversionPlan, inspect } from './inspector'
import { remux } from './remuxer'

export interface ConvertOptions {
  /** Overall progress, 0..1. Remuxing reports 1 immediately — there is no slow phase. */
  onProgress?: (progress: number) => void
  signal?: AbortSignal
  /** AAC bitrate for the audio-transcode path. Default 128000. */
  audioBitrate?: number
  /** Test hook: replace the WebCodecs AAC encoder. */
  aacEncoder?: AacEncoder
}

export interface ConvertResult {
  blob: Blob
  /** Which path was taken; useful for UI ("lossless instant conversion"). */
  method: ConversionMethod
  plan: ConversionPlan
}

/**
 * Preflight: parse the file and report which conversion path it would take,
 * without converting anything. Throws MovParseError / UnsupportedFormatError
 * for files that cannot be handled at all.
 */
export async function canConvert(file: Blob): Promise<ConversionPlan> {
  return inspect(await parseMovie(file))
}

/**
 * Convert a MOV file to MP4, automatically picking the cheapest path:
 *
 * - `remux`: container rewrite only (H.264/HEVC + AAC sources). Lossless,
 *   constant memory, effectively instant.
 * - `audio-transcode`: video copied verbatim, PCM audio re-encoded to AAC
 *   via WebCodecs (typical camera footage).
 * - `full-transcode`: not implemented yet; throws UnsupportedFormatError.
 */
export async function convertMovToMp4(
  file: Blob,
  opts: ConvertOptions = {},
): Promise<ConvertResult> {
  opts.signal?.throwIfAborted()
  const movie = await parseMovie(file)
  const plan = inspect(movie)
  opts.signal?.throwIfAborted()

  switch (plan.method) {
    case 'remux': {
      const { blob } = remux(movie, plan)
      opts.onProgress?.(1)
      return { blob, method: plan.method, plan }
    }
    case 'audio-transcode': {
      const transcodeOpts: Parameters<typeof audioTranscode>[2] = {}
      if (opts.aacEncoder !== undefined) transcodeOpts.encoder = opts.aacEncoder
      if (opts.audioBitrate !== undefined) transcodeOpts.bitrate = opts.audioBitrate
      if (opts.onProgress !== undefined) transcodeOpts.onProgress = opts.onProgress
      if (opts.signal !== undefined) transcodeOpts.signal = opts.signal
      const { blob } = await audioTranscode(movie, plan, transcodeOpts)
      opts.onProgress?.(1)
      return { blob, method: plan.method, plan }
    }
    case 'full-transcode':
      throw new UnsupportedFormatError(
        `this file requires full transcoding (video '${plan.video?.format ?? 'none'}', ` +
          `audio '${plan.audio?.format ?? 'none'}'), which is not implemented yet`,
      )
  }
}
