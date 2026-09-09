import type { BoxHeader, ParsedMovie, ParsedTrack } from './box-reader'
import { iterBoxes } from './box-reader'
import { ByteWriter, dataView } from './bytes'
import { ConversionError } from './errors'
import type { ConversionPlan } from './inspector'
import { buildFtyp } from './mp4-writer'

const U32_MAX = 0xffffffff

/** Maps byte ranges of the input file to their positions in the output file. */
export interface RelocationSegment {
  oldStart: number
  oldEnd: number
  delta: number
}

export interface KeptTrack {
  track: ParsedTrack
  /** Start of this trak box within the NEW moov bytes. */
  newTrakStart: number
}

function relocate(segments: RelocationSegment[], offset: number): number {
  for (const seg of segments) {
    if (offset >= seg.oldStart && offset < seg.oldEnd) return offset + seg.delta
  }
  throw new ConversionError(
    `chunk offset ${offset} does not fall inside any copied data box; corrupt sample table?`,
  )
}

/**
 * Rebuild moov: keep every child verbatim except dropped trak boxes, and
 * normalize the header to 32-bit size. Returns the new bytes plus where each
 * kept trak landed.
 */
export function rebuildMoov(
  movie: ParsedMovie,
  keptTrackIds: Set<number>,
): {
  moovBytes: Uint8Array
  keptTracks: KeptTrack[]
} {
  const src = movie.moovBytes
  const trakByStart = new Map(movie.tracks.map((t) => [t.trakStart, t]))

  const body = new ByteWriter(src.length)
  const keptTracks: KeptTrack[] = []

  for (const child of iterBoxes(src, movie.moov.headerSize, src.length)) {
    if (child.type === 'trak') {
      const track = trakByStart.get(child.start)
      if (track === undefined || !keptTrackIds.has(track.trackId)) continue
      keptTracks.push({ track, newTrakStart: 8 + body.length })
    }
    body.bytes(src.subarray(child.start, child.end))
  }

  const bodyBytes = body.toUint8Array()
  const header = new ByteWriter(8).u32(8 + bodyBytes.length).fourcc('moov')
  const moovBytes = new ByteWriter(8 + bodyBytes.length)
    .bytes(header.toUint8Array())
    .bytes(bodyBytes)
    .toUint8Array()
  return { moovBytes, keptTracks }
}

/** Rewrite hev1 sample entries to hvc1 (required for Safari/QuickTime playback). */
export function retagHevc(moovBytes: Uint8Array, kept: KeptTrack): void {
  for (const entry of kept.track.stsdEntries) {
    if (entry.format !== 'hev1') continue
    const formatPos = entry.posInMoov - kept.track.trakStart + kept.newTrakStart + 4
    moovBytes.set([0x68, 0x76, 0x63, 0x31], formatPos) // 'hvc1'
  }
}

export function patchChunkOffsets(
  moovBytes: Uint8Array,
  kept: KeptTrack,
  segments: RelocationSegment[],
): void {
  const { tables } = kept.track
  const tablePos = tables.chunkOffsetTablePos - kept.track.trakStart + kept.newTrakStart
  const dv = dataView(moovBytes)
  for (let i = 0; i < tables.chunkOffsets.length; i++) {
    const oldOffset = tables.chunkOffsets[i] as number
    const newOffset = relocate(segments, oldOffset)
    if (tables.co64) {
      dv.setBigUint64(tablePos + i * 8, BigInt(newOffset))
    } else {
      if (newOffset > U32_MAX) {
        // Only reachable when relocation pushes a ~4GB file across the 32-bit
        // boundary; sources beyond 4GB already use co64.
        throw new ConversionError(
          'relocated chunk offset exceeds 32 bits; stco-to-co64 upgrade is not implemented yet',
        )
      }
      dv.setUint32(tablePos + i * 4, newOffset)
    }
  }
}

export interface RemuxOutput {
  blob: Blob
}

/**
 * Tier 1: rewrite the container without touching any media data.
 *
 * Output layout is faststart: [ftyp][moov][data boxes in original order].
 * Media bytes are carried as lazy Blob slices of the input — nothing is
 * copied through memory regardless of file size.
 */
export function remux(movie: ParsedMovie, plan: ConversionPlan): RemuxOutput {
  if (plan.method !== 'remux') {
    throw new ConversionError(`remux() called with a '${plan.method}' plan`)
  }

  const keptTrackIds = new Set<number>()
  if (plan.video !== null) keptTrackIds.add(plan.video.trackId)
  if (plan.audio !== null) keptTrackIds.add(plan.audio.trackId)

  const { moovBytes, keptTracks } = rebuildMoov(movie, keptTrackIds)

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

  for (const kept of keptTracks) {
    retagHevc(moovBytes, kept)
    patchChunkOffsets(moovBytes, kept, segments)
  }

  const parts: BlobPart[] = [
    ftypBytes as BlobPart,
    moovBytes as BlobPart,
    ...dataBoxes.map((b) => movie.blob.slice(b.start, b.end)),
  ]
  return { blob: new Blob(parts, { type: 'video/mp4' }) }
}
