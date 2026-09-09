import { ByteWriter } from '../../src/bytes'
import { box, concatBytes as concat, fullBox, largeBox, u16, u32, u64 } from '../../src/mp4-writer'

export { box, concat, fullBox, largeBox, u16, u32, u64 }

export function zeros(n: number): Uint8Array {
  return new Uint8Array(n)
}

const IDENTITY_MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000)

export interface SynthTrackSpec {
  id: number
  handler: 'vide' | 'soun' | 'tmcd'
  format: string
  timescale: number
  sampleDelta: number
  sampleSizes: number[]
  chunkOffsets: number[]
  samplesPerChunk: number
  co64?: boolean
  audio?: { channels: number; bits: number; rate: number }
  /** Extra boxes appended inside stbl (e.g. a colr sibling for tests). */
  extraStsdBytes?: Uint8Array
}

function tkhd(spec: SynthTrackSpec): Uint8Array {
  const dur = spec.sampleSizes.length * spec.sampleDelta
  return fullBox(
    'tkhd',
    0,
    3,
    u32(0, 0, spec.id, 0, dur),
    zeros(8),
    u16(0, 0, 0, 0),
    IDENTITY_MATRIX,
    u32(0, 0),
  )
}

function mdhd(spec: SynthTrackSpec): Uint8Array {
  const dur = spec.sampleSizes.length * spec.sampleDelta
  return fullBox('mdhd', 0, 0, u32(0, 0, spec.timescale, dur), u16(0x55c4, 0))
}

function hdlr(subtype: string): Uint8Array {
  const w = new ByteWriter().fourcc('mhlr').fourcc(subtype)
  return fullBox('hdlr', 0, 0, w.toUint8Array(), zeros(12), new Uint8Array(1))
}

function stsdEntry(spec: SynthTrackSpec): Uint8Array {
  if (spec.handler === 'soun') {
    const a = spec.audio ?? { channels: 2, bits: 16, rate: 48000 }
    const body = new ByteWriter()
      .zeros(6)
      .u16(1) // data ref index
      .u16(0) // version 0
      .u16(0)
      .u32(0)
      .u16(a.channels)
      .u16(a.bits)
      .u16(0)
      .u16(0)
      .u32(Math.round(a.rate * 65536))
    return box(spec.format, body.toUint8Array())
  }
  // Video/timecode entries: header + fixed 70-byte description (zeroed is fine for tests).
  const body = new ByteWriter().zeros(6).u16(1).zeros(70)
  return box(spec.format, body.toUint8Array())
}

function stbl(spec: SynthTrackSpec): Uint8Array {
  const stsd = fullBox('stsd', 0, 0, u32(1), stsdEntry(spec))
  const stts = fullBox('stts', 0, 0, u32(1, spec.sampleSizes.length, spec.sampleDelta))
  const stsc = fullBox('stsc', 0, 0, u32(1, 1, spec.samplesPerChunk, 1))
  const stsz = fullBox('stsz', 0, 0, u32(0, spec.sampleSizes.length), u32(...spec.sampleSizes))
  const chunkBox = spec.co64
    ? fullBox('co64', 0, 0, u32(spec.chunkOffsets.length), u64(...spec.chunkOffsets))
    : fullBox('stco', 0, 0, u32(spec.chunkOffsets.length), u32(...spec.chunkOffsets))
  const children = [stsd, stts, stsc, stsz, chunkBox]
  if (spec.handler === 'vide') {
    children.push(fullBox('stss', 0, 0, u32(1, 1)))
  }
  return box('stbl', ...children)
}

export function trak(spec: SynthTrackSpec): Uint8Array {
  const minf = box('minf', stbl(spec))
  const mdia = box('mdia', mdhd(spec), hdlr(spec.handler), minf)
  return box('trak', tkhd(spec), mdia)
}

export function moov(movieTimescale: number, duration: number, traks: Uint8Array[]): Uint8Array {
  const mvhd = fullBox(
    'mvhd',
    0,
    0,
    u32(0, 0, movieTimescale, duration),
    u32(0x00010000),
    u16(0x0100, 0),
    zeros(8),
    IDENTITY_MATRIX,
    zeros(24),
    u32(traks.length + 1),
  )
  return box('moov', mvhd, ...traks)
}

export function ftyp(majorBrand = 'qt  '): Uint8Array {
  return box(
    'ftyp',
    concat(new ByteWriter().fourcc(majorBrand).u32(0).fourcc(majorBrand).toUint8Array()),
  )
}

export interface SynthMovOptions {
  moovAtEnd?: boolean
  majorBrand?: string
  largeMdat?: boolean
  mdatPayload: Uint8Array
  tracks: SynthTrackSpec[]
  movieTimescale?: number
}

/**
 * Build a complete synthetic MOV. Chunk offsets in track specs are relative to
 * the start of the mdat payload; this function shifts them to absolute file
 * offsets based on the chosen layout.
 */
export function buildMov(opts: SynthMovOptions): { bytes: Uint8Array; mdatPayloadStart: number } {
  const ftypBytes = ftyp(opts.majorBrand ?? 'qt  ')
  const mdatHeaderSize = opts.largeMdat ? 16 : 8
  const mdatBytes = opts.largeMdat
    ? largeBox('mdat', opts.mdatPayload)
    : box('mdat', opts.mdatPayload)

  const timescale = opts.movieTimescale ?? 600
  const duration = Math.max(
    ...opts.tracks.map((t) =>
      Math.round((t.sampleSizes.length * t.sampleDelta * timescale) / t.timescale),
    ),
  )

  const layout = (mdatStart: number) => {
    const traks = opts.tracks.map((t) =>
      trak({
        ...t,
        chunkOffsets: t.chunkOffsets.map((o) => o + mdatStart + mdatHeaderSize),
      }),
    )
    return moov(timescale, duration, traks)
  }

  if (opts.moovAtEnd ?? true) {
    const mdatStart = ftypBytes.length
    const moovBytes = layout(mdatStart)
    return {
      bytes: concat(ftypBytes, mdatBytes, moovBytes),
      mdatPayloadStart: mdatStart + mdatHeaderSize,
    }
  }
  // moov before mdat: moov size does not depend on offsets (sizes are fixed),
  // so build once with a placeholder to learn the size, then rebuild.
  const placeholder = layout(0)
  const mdatStart = ftypBytes.length + placeholder.length
  const moovBytes = layout(mdatStart)
  if (moovBytes.length !== placeholder.length) throw new Error('synth moov size instability')
  return {
    bytes: concat(ftypBytes, moovBytes, mdatBytes),
    mdatPayloadStart: mdatStart + mdatHeaderSize,
  }
}

export function asBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart])
}
