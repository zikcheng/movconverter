import {
  type AacEncoder,
  buildAacTrak,
  DEFAULT_PRIMING_SAMPLES,
  synthesizeAsc,
  webCodecsAacEncoder,
} from './aac'
import type { BoxHeader, ParsedMovie, ParsedTrack } from './box-reader'
import { ByteWriter, dataView } from './bytes'
import { ConversionError } from './errors'
import type { ConversionPlan } from './inspector'
import { box, buildFtyp } from './mp4-writer'
import { extractPcmChunks, pcmToF32, resolvePcmKind } from './pcm'
import { patchChunkOffsets, type RelocationSegment, rebuildMoov, retagHevc } from './remuxer'

const U32_MAX = 0xffffffff

export interface AudioTranscodeOptions {
  /** AAC encoder implementation; defaults to WebCodecs. Tests inject a fake. */
  encoder?: AacEncoder
  bitrate?: number
  primingSamples?: number
  /** Progress over the PCM encoding phase, 0..1. */
  onProgress?: (progress: number) => void
}

export interface AudioTranscodeOutput {
  blob: Blob
}

function totalPcmBytes(track: ParsedTrack): number {
  const { sampleSizes, sampleSizeDefault, sampleCount } = track.tables
  if (sampleSizes === null) return sampleCount * sampleSizeDefault
  let total = 0
  for (const size of sampleSizes) total += size
  return total
}

/**
 * Tier 2: copy the video track verbatim, re-encode PCM audio to AAC.
 *
 * Output layout: [ftyp][moov][original data boxes][new audio mdat].
 * The original PCM bytes ride along unreferenced inside the copied mdat;
 * trimming them is a planned optimization.
 */
export async function audioTranscode(
  movie: ParsedMovie,
  plan: ConversionPlan,
  opts: AudioTranscodeOptions = {},
): Promise<AudioTranscodeOutput> {
  if (plan.method !== 'audio-transcode') {
    throw new ConversionError(`audioTranscode() called with a '${plan.method}' plan`)
  }
  const audioPlan = plan.audio
  if (audioPlan === null || audioPlan.action !== 'webcodecs') {
    throw new ConversionError('audio-transcode plan without a webcodecs audio track')
  }
  const audioTrack = movie.tracks.find((t) => t.trackId === audioPlan.trackId)
  if (audioTrack === undefined || audioTrack.audio === null) {
    throw new ConversionError('audio track vanished between inspect() and conversion')
  }

  const { channels, sampleRate } = audioTrack.audio
  if (channels < 1 || channels > 8 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new ConversionError(`implausible audio parameters: ${channels}ch @ ${sampleRate}Hz`)
  }
  const kind = resolvePcmKind(audioPlan.format, audioTrack.audio)
  const bitrate = opts.bitrate ?? 128000
  const encoder = opts.encoder ?? webCodecsAacEncoder

  // Phase 1: stream PCM chunks through the encoder (one chunk in memory at a time).
  const pcmTotal = totalPcmBytes(audioTrack)
  const onProgress = opts.onProgress
  async function* pcmStream(): AsyncGenerator<Float32Array> {
    let read = 0
    for await (const chunk of extractPcmChunks(movie.blob, audioTrack as ParsedTrack)) {
      read += chunk.length
      yield pcmToF32(chunk, kind)
      onProgress?.(pcmTotal > 0 ? Math.min(read / pcmTotal, 1) : 1)
    }
  }
  const encoded = await encoder(pcmStream(), { sampleRate, channels, bitrate })
  if (encoded.frames.length === 0) {
    throw new ConversionError('AAC encoder produced no output')
  }
  const asc = encoded.audioSpecificConfig ?? synthesizeAsc(sampleRate, channels)

  // Phase 2: rebuild moov with the video track kept and a new AAC trak appended.
  const keptIds = new Set<number>()
  if (plan.video !== null) keptIds.add(plan.video.trackId)
  const { moovBytes: baseMoov, keptTracks } = rebuildMoov(movie, keptIds)

  const aacTrak = buildAacTrak({
    trackId: audioPlan.trackId,
    sampleRate,
    channels,
    asc,
    sampleSizes: encoded.frames.map((f) => f.length),
    movieTimescale: movie.movieTimescale,
    primingSamples: opts.primingSamples ?? DEFAULT_PRIMING_SAMPLES,
    avgBitrate: bitrate,
  })

  const moovBytes = new ByteWriter(baseMoov.length + aacTrak.bytes.length)
    .u32(baseMoov.length + aacTrak.bytes.length)
    .fourcc('moov')
    .bytes(baseMoov.subarray(8))
    .bytes(aacTrak.bytes)
    .toUint8Array()
  const audioStcoPos = baseMoov.length + aacTrak.stcoEntryPos

  // Phase 3: lay out the output and patch every file offset.
  const ftypBytes = buildFtyp()
  const dataBoxes: BoxHeader[] = movie.topLevel.filter(
    (b) => b.type !== 'ftyp' && b.type !== 'moov',
  )
  const segments: RelocationSegment[] = []
  let cursor = ftypBytes.length + moovBytes.length
  for (const b of dataBoxes) {
    segments.push({ oldStart: b.start, oldEnd: b.end, delta: cursor - b.start })
    cursor += b.size
  }
  const audioMdat = box('mdat', ...encoded.frames)
  const audioPayloadStart = cursor + 8

  for (const kept of keptTracks) {
    retagHevc(moovBytes, kept)
    patchChunkOffsets(moovBytes, kept, segments)
  }
  if (audioPayloadStart > U32_MAX) {
    throw new ConversionError(
      'audio chunk offset exceeds 32 bits; co64 audio tracks are not implemented yet',
    )
  }
  dataView(moovBytes).setUint32(audioStcoPos, audioPayloadStart)

  const parts: BlobPart[] = [
    ftypBytes as BlobPart,
    moovBytes as BlobPart,
    ...dataBoxes.map((b) => movie.blob.slice(b.start, b.end)),
    audioMdat as BlobPart,
  ]
  return { blob: new Blob(parts, { type: 'video/mp4' }) }
}
