import type { AudioSampleInfo, ParsedTrack } from './box-reader'
import { dataView, readBytes } from './bytes'
import { MovParseError, UnsupportedFormatError } from './errors'

export type PcmKind =
  | 'u8'
  | 's8'
  | 's16le'
  | 's16be'
  | 's24be'
  | 's24le'
  | 's32be'
  | 's32le'
  | 'f32le'
  | 'f32be'
  | 'f64le'
  | 'f64be'

const FLAG_FLOAT = 0x1
const FLAG_BIG_ENDIAN = 0x2

export function bytesPerSample(kind: PcmKind): number {
  switch (kind) {
    case 'u8':
    case 's8':
      return 1
    case 's16le':
    case 's16be':
      return 2
    case 's24be':
    case 's24le':
      return 3
    case 's32be':
    case 's32le':
    case 'f32le':
    case 'f32be':
      return 4
    case 'f64le':
    case 'f64be':
      return 8
  }
}

/** Map a QuickTime sound format + description to a concrete PCM layout. */
export function resolvePcmKind(format: string, audio: AudioSampleInfo): PcmKind {
  switch (format) {
    case 'raw ':
      return 'u8'
    case 'sowt':
      return audio.bitsPerSample === 8 ? 's8' : 's16le'
    case 'twos':
    case 'NONE':
      return audio.bitsPerSample === 8 ? 's8' : 's16be'
    case 'in24':
      return 's24be'
    case 'in32':
      return 's32be'
    case 'lpcm': {
      const flags = audio.lpcmFlags ?? 0
      const be = (flags & FLAG_BIG_ENDIAN) !== 0
      if ((flags & FLAG_FLOAT) !== 0) {
        if (audio.bitsPerSample === 32) return be ? 'f32be' : 'f32le'
        if (audio.bitsPerSample === 64) return be ? 'f64be' : 'f64le'
        throw new UnsupportedFormatError(`lpcm float with ${audio.bitsPerSample} bits`)
      }
      switch (audio.bitsPerSample) {
        case 16:
          return be ? 's16be' : 's16le'
        case 24:
          return be ? 's24be' : 's24le'
        case 32:
          return be ? 's32be' : 's32le'
        default:
          throw new UnsupportedFormatError(`lpcm integer with ${audio.bitsPerSample} bits`)
      }
    }
    default:
      throw new UnsupportedFormatError(`'${format}' is not an uncompressed PCM format`)
  }
}

/** Convert interleaved PCM bytes to interleaved f32 in [-1, 1]. */
export function pcmToF32(bytes: Uint8Array, kind: PcmKind): Float32Array {
  const stride = bytesPerSample(kind)
  const n = Math.floor(bytes.length / stride)
  const out = new Float32Array(n)
  const dv = dataView(bytes)
  for (let i = 0; i < n; i++) {
    const o = i * stride
    switch (kind) {
      case 'u8':
        out[i] = ((bytes[o] ?? 0) - 128) / 128
        break
      case 's8':
        out[i] = dv.getInt8(o) / 128
        break
      case 's16le':
        out[i] = dv.getInt16(o, true) / 32768
        break
      case 's16be':
        out[i] = dv.getInt16(o, false) / 32768
        break
      case 's24be':
        out[i] = ((dv.getInt16(o, false) << 8) | (bytes[o + 2] ?? 0)) / 8388608
        break
      case 's24le':
        out[i] = ((dv.getInt16(o + 1, true) << 8) | (bytes[o] ?? 0)) / 8388608
        break
      case 's32be':
        out[i] = dv.getInt32(o, false) / 2147483648
        break
      case 's32le':
        out[i] = dv.getInt32(o, true) / 2147483648
        break
      case 'f32be':
        out[i] = dv.getFloat32(o, false)
        break
      case 'f32le':
        out[i] = dv.getFloat32(o, true)
        break
      case 'f64be':
        out[i] = dv.getFloat64(o, false)
        break
      case 'f64le':
        out[i] = dv.getFloat64(o, true)
        break
    }
  }
  return out
}

/** Total samples per chunk, expanded from the stsc run-length table. */
export function samplesPerChunkTable(track: ParsedTrack, chunkCount: number): Uint32Array {
  const { firstChunk, samplesPerChunk } = track.tables.stsc
  const out = new Uint32Array(chunkCount)
  for (let run = 0; run < firstChunk.length; run++) {
    const start = (firstChunk[run] ?? 1) - 1
    const end = run + 1 < firstChunk.length ? (firstChunk[run + 1] ?? 1) - 1 : chunkCount
    out.fill(samplesPerChunk[run] ?? 0, start, Math.min(end, chunkCount))
  }
  return out
}

/** Byte length of one chunk, derived from its samples' stsz sizes. */
function chunkByteLength(track: ParsedTrack, firstSample: number, sampleCount: number): number {
  const { sampleSizes, sampleSizeDefault } = track.tables
  if (sampleSizes === null) return sampleCount * sampleSizeDefault
  let total = 0
  for (let i = 0; i < sampleCount; i++) total += sampleSizes[firstSample + i] ?? 0
  return total
}

/**
 * Stream a PCM track's raw bytes chunk by chunk, in playback order.
 * Only one chunk is in memory at a time.
 */
export async function* extractPcmChunks(
  blob: Blob,
  track: ParsedTrack,
): AsyncGenerator<Uint8Array> {
  const offsets = track.tables.chunkOffsets
  const perChunk = samplesPerChunkTable(track, offsets.length)
  let sampleCursor = 0
  for (let i = 0; i < offsets.length; i++) {
    const sampleCount = perChunk[i] ?? 0
    const byteLength = chunkByteLength(track, sampleCursor, sampleCount)
    sampleCursor += sampleCount
    if (byteLength === 0) continue
    const chunk = await readBytes(blob, offsets[i] ?? 0, byteLength)
    if (chunk.length !== byteLength) {
      throw new MovParseError(`audio chunk ${i} is truncated (${chunk.length}/${byteLength} bytes)`)
    }
    yield chunk
  }
}
