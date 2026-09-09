import { dataView, fourcc, readBytes } from './bytes'
import { MovParseError, UnsupportedFormatError } from './errors'

/** A box located in the underlying Blob (absolute offsets). */
export interface BoxHeader {
  type: string
  start: number
  size: number
  headerSize: number
  end: number
}

/** A box located inside an in-memory buffer (offsets relative to that buffer). */
export interface InlineBox {
  type: string
  start: number
  size: number
  headerSize: number
  end: number
}

export interface SampleToChunk {
  firstChunk: Uint32Array
  samplesPerChunk: Uint32Array
  descIndex: Uint32Array
}

export interface SampleTables {
  /** stts run-length pairs. */
  sttsCounts: Uint32Array
  sttsDeltas: Uint32Array
  /** Sync sample numbers (1-based), null when every sample is a keyframe. */
  stss: Uint32Array | null
  stsc: SampleToChunk
  /** stsz: uniform size when sizes === null. */
  sampleSizeDefault: number
  sampleSizes: Uint32Array | null
  sampleCount: number
  /** Chunk offsets are absolute file offsets. Float64 is exact up to 2^53. */
  chunkOffsets: Float64Array
  co64: boolean
  /** Offset (within moov bytes) of the first chunk-offset entry, for patching. */
  chunkOffsetTablePos: number
}

export interface StsdEntry {
  format: string
  /** Offset of the entry (its size field) within moov bytes. */
  posInMoov: number
  size: number
}

export interface AudioSampleInfo {
  stsdVersion: number
  channels: number
  sampleRate: number
  bitsPerSample: number
  /** CoreAudio formatSpecificFlags (v2 'lpcm' only): 0x1 float, 0x2 big-endian, 0x4 signed. */
  lpcmFlags: number | null
}

export interface ParsedTrack {
  trackId: number
  /** Handler subtype: 'vide', 'soun', 'tmcd', ... */
  handler: string
  timescale: number
  duration: number
  /** Position of the whole trak box within moov bytes. */
  trakStart: number
  trakEnd: number
  stsdEntries: StsdEntry[]
  tables: SampleTables
  audio: AudioSampleInfo | null
}

export interface ParsedMovie {
  blob: Blob
  fileSize: number
  topLevel: BoxHeader[]
  ftyp: BoxHeader | null
  majorBrand: string | null
  moov: BoxHeader
  moovBytes: Uint8Array
  movieTimescale: number
  movieDuration: number
  tracks: ParsedTrack[]
}

const MAX_MOOV_SIZE = 512 * 1024 * 1024

/** Read one box header at an absolute offset. Returns null at EOF. */
export async function readBoxHeaderAt(blob: Blob, offset: number): Promise<BoxHeader | null> {
  if (offset + 8 > blob.size) return null
  const head = await readBytes(blob, offset, 16)
  const dv = dataView(head)
  let size = dv.getUint32(0)
  const type = fourcc(head, 4)
  let headerSize = 8
  if (size === 1) {
    if (head.length < 16) throw new MovParseError(`truncated 64-bit box header at offset ${offset}`)
    size = Number(dv.getBigUint64(8))
    headerSize = 16
  } else if (size === 0) {
    // Box extends to end of file (legal only for the last top-level box).
    size = blob.size - offset
  }
  if (size < headerSize) {
    throw new MovParseError(`invalid box size ${size} for '${type}' at offset ${offset}`)
  }
  return { type, start: offset, size, headerSize, end: offset + size }
}

/** Scan all top-level boxes. Cheap: only headers are read, payloads are skipped. */
export async function listTopLevelBoxes(blob: Blob): Promise<BoxHeader[]> {
  const out: BoxHeader[] = []
  let offset = 0
  while (offset + 8 <= blob.size) {
    const h = await readBoxHeaderAt(blob, offset)
    if (h === null) break
    if (h.end > blob.size) {
      throw new MovParseError(`box '${h.type}' at offset ${h.start} extends beyond end of file`)
    }
    out.push(h)
    offset = h.end
  }
  return out
}

/** Iterate child boxes inside an in-memory buffer range. */
export function* iterBoxes(bytes: Uint8Array, start: number, end: number): Generator<InlineBox> {
  const dv = dataView(bytes)
  let offset = start
  while (offset + 8 <= end) {
    let size = dv.getUint32(offset)
    const type = fourcc(bytes, offset + 4)
    let headerSize = 8
    if (size === 1) {
      if (offset + 16 > end) throw new MovParseError(`truncated 64-bit box header in '${type}'`)
      size = Number(dv.getBigUint64(offset + 8))
      headerSize = 16
    } else if (size === 0) {
      size = end - offset
    }
    if (size < headerSize || offset + size > end) {
      throw new MovParseError(`invalid child box size ${size} for '${type}' at offset ${offset}`)
    }
    yield { type, start: offset, size, headerSize, end: offset + size }
    offset += size
  }
}

export function findBox(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: string,
): InlineBox | null {
  for (const box of iterBoxes(bytes, start, end)) {
    if (box.type === type) return box
  }
  return null
}

function requireBox(bytes: Uint8Array, parent: InlineBox, type: string): InlineBox {
  const box = findBox(bytes, parent.start + parent.headerSize, parent.end, type)
  if (box === null) throw new MovParseError(`missing '${type}' inside '${parent.type}'`)
  return box
}

function payload(box: InlineBox): number {
  return box.start + box.headerSize
}

function parseMvhd(bytes: Uint8Array, mvhd: InlineBox): { timescale: number; duration: number } {
  const dv = dataView(bytes)
  const p = payload(mvhd)
  const version = dv.getUint8(p)
  if (version === 1) {
    return { timescale: dv.getUint32(p + 20), duration: Number(dv.getBigUint64(p + 24)) }
  }
  return { timescale: dv.getUint32(p + 12), duration: dv.getUint32(p + 16) }
}

function parseTkhdTrackId(bytes: Uint8Array, tkhd: InlineBox): number {
  const dv = dataView(bytes)
  const p = payload(tkhd)
  const version = dv.getUint8(p)
  // v0: vf(4) ctime(4) mtime(4) id(4); v1: vf(4) ctime(8) mtime(8) id(4)
  return dv.getUint32(version === 1 ? p + 20 : p + 12)
}

function parseMdhd(bytes: Uint8Array, mdhd: InlineBox): { timescale: number; duration: number } {
  const dv = dataView(bytes)
  const p = payload(mdhd)
  const version = dv.getUint8(p)
  if (version === 1) {
    return { timescale: dv.getUint32(p + 20), duration: Number(dv.getBigUint64(p + 24)) }
  }
  return { timescale: dv.getUint32(p + 12), duration: dv.getUint32(p + 16) }
}

function parseHdlr(bytes: Uint8Array, hdlr: InlineBox): string {
  // fullbox vf(4), pre_defined/component-type(4), handler subtype(4)
  return fourcc(bytes, payload(hdlr) + 8)
}

function parseStsd(bytes: Uint8Array, stsd: InlineBox): StsdEntry[] {
  const dv = dataView(bytes)
  const p = payload(stsd)
  const entryCount = dv.getUint32(p + 4)
  const entries: StsdEntry[] = []
  let offset = p + 8
  for (let i = 0; i < entryCount; i++) {
    if (offset + 8 > stsd.end) throw new MovParseError('truncated stsd entry')
    const size = dv.getUint32(offset)
    if (size < 8 || offset + size > stsd.end) {
      throw new MovParseError(`invalid stsd entry size ${size}`)
    }
    entries.push({ format: fourcc(bytes, offset + 4), posInMoov: offset, size })
    offset += size
  }
  return entries
}

/**
 * Parse the QuickTime SoundDescription that follows the 8-byte stsd entry
 * header. Handles versions 0, 1 and 2.
 */
function parseAudioSampleEntry(bytes: Uint8Array, entry: StsdEntry): AudioSampleInfo | null {
  const dv = dataView(bytes)
  // entry header(8) + reserved(6) + dataRefIndex(2)
  const p = entry.posInMoov + 16
  if (p + 20 > entry.posInMoov + entry.size) return null
  const version = dv.getUint16(p)
  if (version === 2) {
    // v2: version(2) revision(2) vendor(4) always3(2) always16(2) alwaysMinus2(2)
    //     always0(2) always65536(4) sizeOfStructOnly(4) sampleRate(f64) channels(4)
    //     always7F000000(4) constBitsPerChannel(4) formatSpecificFlags(4) ...
    if (p + 48 > entry.posInMoov + entry.size) return null
    return {
      stsdVersion: 2,
      sampleRate: dv.getFloat64(p + 24),
      channels: dv.getUint32(p + 32),
      bitsPerSample: dv.getUint32(p + 40),
      lpcmFlags: dv.getUint32(p + 44),
    }
  }
  // v0/v1: version(2) revision(2) vendor(4) channels(2) sampleSize(2)
  //        compressionId(2) packetSize(2) sampleRate(16.16 fixed)
  return {
    stsdVersion: version,
    channels: dv.getUint16(p + 8),
    bitsPerSample: dv.getUint16(p + 10),
    sampleRate: dv.getUint32(p + 16) / 65536,
    lpcmFlags: null,
  }
}

function parseSampleTables(bytes: Uint8Array, stbl: InlineBox): SampleTables {
  const dv = dataView(bytes)

  const stts = requireBox(bytes, stbl, 'stts')
  const sttsCount = dv.getUint32(payload(stts) + 4)
  const sttsCounts = new Uint32Array(sttsCount)
  const sttsDeltas = new Uint32Array(sttsCount)
  for (let i = 0; i < sttsCount; i++) {
    sttsCounts[i] = dv.getUint32(payload(stts) + 8 + i * 8)
    sttsDeltas[i] = dv.getUint32(payload(stts) + 12 + i * 8)
  }

  const stssBox = findBox(bytes, stbl.start + stbl.headerSize, stbl.end, 'stss')
  let stss: Uint32Array | null = null
  if (stssBox !== null) {
    const n = dv.getUint32(payload(stssBox) + 4)
    stss = new Uint32Array(n)
    for (let i = 0; i < n; i++) stss[i] = dv.getUint32(payload(stssBox) + 8 + i * 4)
  }

  const stsc = requireBox(bytes, stbl, 'stsc')
  const stscCount = dv.getUint32(payload(stsc) + 4)
  const firstChunk = new Uint32Array(stscCount)
  const samplesPerChunk = new Uint32Array(stscCount)
  const descIndex = new Uint32Array(stscCount)
  for (let i = 0; i < stscCount; i++) {
    firstChunk[i] = dv.getUint32(payload(stsc) + 8 + i * 12)
    samplesPerChunk[i] = dv.getUint32(payload(stsc) + 12 + i * 12)
    descIndex[i] = dv.getUint32(payload(stsc) + 16 + i * 12)
  }

  const stsz = requireBox(bytes, stbl, 'stsz')
  const sampleSizeDefault = dv.getUint32(payload(stsz) + 4)
  const sampleCount = dv.getUint32(payload(stsz) + 8)
  let sampleSizes: Uint32Array | null = null
  if (sampleSizeDefault === 0) {
    sampleSizes = new Uint32Array(sampleCount)
    for (let i = 0; i < sampleCount; i++) {
      sampleSizes[i] = dv.getUint32(payload(stsz) + 12 + i * 4)
    }
  }

  const stcoBox = findBox(bytes, stbl.start + stbl.headerSize, stbl.end, 'stco')
  const co64Box =
    stcoBox === null ? findBox(bytes, stbl.start + stbl.headerSize, stbl.end, 'co64') : null
  const chunkBox = stcoBox ?? co64Box
  if (chunkBox === null) throw new MovParseError("missing 'stco'/'co64' inside 'stbl'")
  const co64 = chunkBox.type === 'co64'
  const chunkCount = dv.getUint32(payload(chunkBox) + 4)
  const chunkOffsetTablePos = payload(chunkBox) + 8
  const chunkOffsets = new Float64Array(chunkCount)
  for (let i = 0; i < chunkCount; i++) {
    chunkOffsets[i] = co64
      ? Number(dv.getBigUint64(chunkOffsetTablePos + i * 8))
      : dv.getUint32(chunkOffsetTablePos + i * 4)
  }

  return {
    sttsCounts,
    sttsDeltas,
    stss,
    stsc: { firstChunk, samplesPerChunk, descIndex },
    sampleSizeDefault,
    sampleSizes,
    sampleCount,
    chunkOffsets,
    co64,
    chunkOffsetTablePos,
  }
}

function parseTrak(bytes: Uint8Array, trak: InlineBox): ParsedTrack {
  const tkhd = requireBox(bytes, trak, 'tkhd')
  const mdia = requireBox(bytes, trak, 'mdia')
  const mdhd = requireBox(bytes, mdia, 'mdhd')
  const hdlr = requireBox(bytes, mdia, 'hdlr')
  const minf = requireBox(bytes, mdia, 'minf')
  const stbl = requireBox(bytes, minf, 'stbl')
  const stsd = requireBox(bytes, stbl, 'stsd')

  const handler = parseHdlr(bytes, hdlr)
  const { timescale, duration } = parseMdhd(bytes, mdhd)
  const stsdEntries = parseStsd(bytes, stsd)
  const firstEntry = stsdEntries[0]
  const audio =
    handler === 'soun' && firstEntry !== undefined ? parseAudioSampleEntry(bytes, firstEntry) : null

  return {
    trackId: parseTkhdTrackId(bytes, tkhd),
    handler,
    timescale,
    duration,
    trakStart: trak.start,
    trakEnd: trak.end,
    stsdEntries,
    tables: parseSampleTables(bytes, stbl),
    audio,
  }
}

/**
 * Parse a MOV/MP4 file. Streaming: only box headers and the moov subtree are
 * read; mdat payloads are never touched.
 */
export async function parseMovie(blob: Blob): Promise<ParsedMovie> {
  const topLevel = await listTopLevelBoxes(blob)
  if (topLevel.length === 0) throw new MovParseError('no boxes found; not a QuickTime/MP4 file')

  const ftyp = topLevel.find((b) => b.type === 'ftyp') ?? null
  const moov = topLevel.find((b) => b.type === 'moov')
  if (moov === undefined) throw new MovParseError("missing 'moov' box (incomplete recording?)")
  if (moov.size > MAX_MOOV_SIZE) {
    throw new MovParseError(`moov box is implausibly large (${moov.size} bytes)`)
  }

  let majorBrand: string | null = null
  if (ftyp !== null && ftyp.size >= ftyp.headerSize + 4) {
    const brandBytes = await readBytes(blob, ftyp.start + ftyp.headerSize, 4)
    majorBrand = fourcc(brandBytes, 0)
  }

  const moovBytes = await readBytes(blob, moov.start, moov.size)
  if (moovBytes.length !== moov.size) throw new MovParseError('truncated moov box')

  const moovInline: InlineBox = {
    type: 'moov',
    start: 0,
    size: moov.size,
    headerSize: moov.headerSize,
    end: moov.size,
  }

  if (findBox(moovBytes, moovInline.headerSize, moovInline.end, 'cmov') !== null) {
    throw new UnsupportedFormatError('compressed moov (cmov) is not supported')
  }

  const mvhd = requireBox(moovBytes, moovInline, 'mvhd')
  const { timescale: movieTimescale, duration: movieDuration } = parseMvhd(moovBytes, mvhd)

  const tracks: ParsedTrack[] = []
  for (const child of iterBoxes(moovBytes, moovInline.headerSize, moovInline.end)) {
    if (child.type === 'trak') tracks.push(parseTrak(moovBytes, child))
  }
  if (tracks.length === 0) throw new MovParseError('no tracks found')

  return {
    blob,
    fileSize: blob.size,
    topLevel,
    ftyp,
    majorBrand,
    moov,
    moovBytes,
    movieTimescale,
    movieDuration,
    tracks,
  }
}
