import { ByteWriter } from './bytes'
import { ConversionError } from './errors'
import { box, fullBox, u16, u32 } from './mp4-writer'

/** AAC-LC frames always cover 1024 PCM frames. */
export const AAC_SAMPLES_PER_FRAME = 1024
/** Apple's conventional AAC encoder delay, used for the elst priming edit. */
export const DEFAULT_PRIMING_SAMPLES = 2112

const SAMPLE_RATE_INDEX: Record<number, number> = {
  96000: 0,
  88200: 1,
  64000: 2,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
  22050: 7,
  16000: 8,
  12000: 9,
  11025: 10,
  8000: 11,
  7350: 12,
}

/** Synthesize an AudioSpecificConfig for AAC-LC when the encoder does not provide one. */
export function synthesizeAsc(sampleRate: number, channels: number): Uint8Array {
  const freqIndex = SAMPLE_RATE_INDEX[sampleRate]
  if (freqIndex === undefined) {
    throw new ConversionError(`no AAC sampling-frequency index for ${sampleRate} Hz`)
  }
  // 5 bits objectType (2 = AAC-LC), 4 bits frequency index, 4 bits channel config, 3 bits zero.
  const bits = (2 << 11) | (freqIndex << 7) | (channels << 3)
  return u16(bits)
}

/** MPEG-4 expandable-length descriptor. */
function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, p) => n + p.length, 0)
  const w = new ByteWriter(5 + size)
  w.u8(tag)
  // Minimal expandable length encoding (7 bits per byte, MSB = continuation).
  if (size < 0x80) {
    w.u8(size)
  } else if (size < 0x4000) {
    w.u8(0x80 | (size >> 7)).u8(size & 0x7f)
  } else {
    w.u8(0x80 | (size >> 21))
      .u8(0x80 | ((size >> 14) & 0x7f))
      .u8(0x80 | ((size >> 7) & 0x7f))
      .u8(size & 0x7f)
  }
  for (const p of parts) w.bytes(p)
  return w.toUint8Array()
}

/** Build the esds box carrying the AudioSpecificConfig. */
export function buildEsds(asc: Uint8Array, avgBitrate = 128000): Uint8Array {
  const decoderConfig = descriptor(
    0x04,
    new ByteWriter()
      .u8(0x40) // objectTypeIndication: MPEG-4 Audio
      .u8(0x15) // streamType audio (0x05 << 2) | reserved 1
      .u8(0)
      .u16(0) // bufferSizeDB (24-bit)
      .u32(avgBitrate) // maxBitrate
      .u32(avgBitrate)
      .toUint8Array(),
    descriptor(0x05, asc), // DecoderSpecificInfo
  )
  const slConfig = descriptor(0x06, new Uint8Array([0x02]))
  const es = descriptor(
    0x03,
    new ByteWriter().u16(0).u8(0).toUint8Array(), // ES_ID, flags
    decoderConfig,
    slConfig,
  )
  return fullBox('esds', 0, 0, es)
}

/** ISO AudioSampleEntry for mp4a with an esds child. */
export function buildMp4aSampleEntry(
  sampleRate: number,
  channels: number,
  asc: Uint8Array,
  avgBitrate?: number,
): Uint8Array {
  const body = new ByteWriter()
    .zeros(6)
    .u16(1) // data reference index
    .zeros(8) // version/revision/vendor (0)
    .u16(channels)
    .u16(16) // sample size
    .u16(0)
    .u16(0)
    .u32(Math.round(sampleRate) * 65536)
  return box('mp4a', body.toUint8Array(), buildEsds(asc, avgBitrate))
}

export interface AacTrakSpec {
  trackId: number
  sampleRate: number
  channels: number
  asc: Uint8Array
  /** Byte size of each encoded AAC frame, in order. */
  sampleSizes: number[]
  movieTimescale: number
  /** Encoder priming samples removed via the elst media time. */
  primingSamples: number
  avgBitrate?: number
}

export interface AacTrakResult {
  bytes: Uint8Array
  /** Position (within the trak bytes) of the single stco entry, for later patching. */
  stcoEntryPos: number
  /** Track duration in movie timescale units (excludes priming). */
  trackDurationMovieTs: number
}

function findStcoEntryPos(trakBytes: Uint8Array): number {
  // The trak is built by us: locate the marker by scanning for the stco box header.
  for (let i = 0; i + 8 <= trakBytes.length; i++) {
    if (
      trakBytes[i + 4] === 0x73 && // s
      trakBytes[i + 5] === 0x74 && // t
      trakBytes[i + 6] === 0x63 && // c
      trakBytes[i + 7] === 0x6f // o
    ) {
      return i + 16 // header(8) + version/flags(4) + entryCount(4)
    }
  }
  throw new ConversionError('internal: stco not found in generated trak')
}

/**
 * Build a complete AAC audio trak. All encoded frames live in one chunk whose
 * file offset is patched in later via `stcoEntryPos`.
 */
export function buildAacTrak(spec: AacTrakSpec): AacTrakResult {
  const totalMediaSamples = spec.sampleSizes.length * AAC_SAMPLES_PER_FRAME
  const presentedSamples = Math.max(0, totalMediaSamples - spec.primingSamples)
  const mediaDuration = totalMediaSamples
  const trackDurationMovieTs = Math.round(
    (presentedSamples / spec.sampleRate) * spec.movieTimescale,
  )

  const tkhd = fullBox(
    'tkhd',
    0,
    3, // enabled + in movie
    u32(0, 0, spec.trackId, 0, trackDurationMovieTs),
    new Uint8Array(8),
    u16(0, 0, 0x0100, 0), // layer, alt group, volume 1.0
    u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000),
    u32(0, 0),
  )

  // Priming edit: presentation skips the encoder delay.
  const elst = fullBox('elst', 0, 0, u32(1, trackDurationMovieTs, spec.primingSamples, 0x00010000))
  const edts = box('edts', elst)

  const mdhd = fullBox(
    'mdhd',
    0,
    0,
    u32(0, 0, Math.round(spec.sampleRate), mediaDuration),
    u16(0x55c4, 0), // language 'und'
  )
  const hdlr = fullBox(
    'hdlr',
    0,
    0,
    u32(0),
    new ByteWriter().fourcc('soun').toUint8Array(),
    new Uint8Array(13),
  )

  const smhd = fullBox('smhd', 0, 0, u32(0))
  const dref = fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))
  const dinf = box('dinf', dref)

  const stsd = fullBox(
    'stsd',
    0,
    0,
    u32(1),
    buildMp4aSampleEntry(spec.sampleRate, spec.channels, spec.asc, spec.avgBitrate),
  )
  const stts = fullBox('stts', 0, 0, u32(1, spec.sampleSizes.length, AAC_SAMPLES_PER_FRAME))
  const stsc = fullBox('stsc', 0, 0, u32(1, 1, spec.sampleSizes.length, 1))
  const stsz = fullBox('stsz', 0, 0, u32(0, spec.sampleSizes.length), u32(...spec.sampleSizes))
  const stco = fullBox('stco', 0, 0, u32(1), u32(0)) // offset patched later

  const stbl = box('stbl', stsd, stts, stsc, stsz, stco)
  const minf = box('minf', smhd, dinf, stbl)
  const mdia = box('mdia', mdhd, hdlr, minf)
  const trak = box('trak', tkhd, edts, mdia)

  return { bytes: trak, stcoEntryPos: findStcoEntryPos(trak), trackDurationMovieTs }
}

export interface AacEncodeInput {
  sampleRate: number
  channels: number
  bitrate: number
}

export interface AacEncodeResult {
  /** One encoded AAC frame per entry (raw, no ADTS). */
  frames: Uint8Array[]
  /** AudioSpecificConfig from the encoder, or null to synthesize one. */
  audioSpecificConfig: Uint8Array | null
}

/** Pluggable AAC encoder; the default uses WebCodecs, tests inject a fake. */
export type AacEncoder = (
  pcm: AsyncIterable<Float32Array>,
  opts: AacEncodeInput,
) => Promise<AacEncodeResult>

interface AudioEncoderLike {
  configure(config: object): void
  encode(data: object): void
  flush(): Promise<void>
  close(): void
}

interface AudioEncoderConstructor {
  new (init: {
    output: (chunk: EncodedChunkLike, metadata?: MetadataLike) => void
    error: (e: Error) => void
  }): AudioEncoderLike
  isConfigSupported(config: object): Promise<{ supported: boolean }>
}

interface EncodedChunkLike {
  byteLength: number
  copyTo(dest: Uint8Array): void
}

interface MetadataLike {
  decoderConfig?: { description?: ArrayBuffer | ArrayBufferView }
}

function getAudioEncoder(): AudioEncoderConstructor | null {
  const g = globalThis as { AudioEncoder?: AudioEncoderConstructor; AudioData?: unknown }
  return g.AudioEncoder && g.AudioData ? g.AudioEncoder : null
}

export async function isWebCodecsAacSupported(
  sampleRate: number,
  channels: number,
): Promise<boolean> {
  const AudioEncoderCtor = getAudioEncoder()
  if (AudioEncoderCtor === null) return false
  try {
    const { supported } = await AudioEncoderCtor.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels: channels,
    })
    return supported
  } catch {
    return false
  }
}

/** Default AacEncoder backed by the WebCodecs AudioEncoder. */
export const webCodecsAacEncoder: AacEncoder = async (pcm, opts) => {
  const AudioEncoderCtor = getAudioEncoder()
  if (AudioEncoderCtor === null) {
    throw new ConversionError('WebCodecs AudioEncoder is not available in this environment')
  }
  const AudioDataCtor = (globalThis as unknown as { AudioData: new (init: object) => object })
    .AudioData

  const frames: Uint8Array[] = []
  let asc: Uint8Array | null = null
  let encoderError: Error | null = null

  const encoder = new AudioEncoderCtor({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      frames.push(data)
      const description = metadata?.decoderConfig?.description
      if (asc === null && description !== undefined) {
        asc = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
          : new Uint8Array(description)
      }
    },
    error: (e) => {
      encoderError = e
    },
  })
  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate: opts.sampleRate,
    numberOfChannels: opts.channels,
    bitrate: opts.bitrate,
  })

  let timestampFrames = 0
  for await (const f32 of pcm) {
    if (encoderError !== null) break
    const numberOfFrames = Math.floor(f32.length / opts.channels)
    if (numberOfFrames === 0) continue
    encoder.encode(
      new AudioDataCtor({
        format: 'f32',
        sampleRate: opts.sampleRate,
        numberOfFrames,
        numberOfChannels: opts.channels,
        timestamp: Math.round((timestampFrames / opts.sampleRate) * 1e6),
        data: f32,
      }),
    )
    timestampFrames += numberOfFrames
  }
  await encoder.flush()
  encoder.close()
  if (encoderError !== null) {
    throw new ConversionError(`AAC encoding failed: ${(encoderError as Error).message}`)
  }
  return { frames, audioSpecificConfig: asc }
}
