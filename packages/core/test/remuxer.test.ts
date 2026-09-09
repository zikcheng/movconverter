import { describe, expect, it } from 'vitest'
import { parseMovie } from '../src/box-reader'
import { readBytes } from '../src/bytes'
import { inspect } from '../src/inspector'
import { remux } from '../src/remuxer'
import { asBlob, buildMov, type SynthTrackSpec } from './helpers/synth'

function patternPayload(size: number): Uint8Array {
  const payload = new Uint8Array(size)
  for (let i = 0; i < size; i++) payload[i] = i & 0xff
  return payload
}

const videoTrack: SynthTrackSpec = {
  id: 1,
  handler: 'vide',
  format: 'avc1',
  timescale: 30000,
  sampleDelta: 1001,
  sampleSizes: [100, 80, 90],
  chunkOffsets: [0],
  samplesPerChunk: 3,
}

const aacTrack: SynthTrackSpec = {
  id: 2,
  handler: 'soun',
  format: 'mp4a',
  timescale: 48000,
  sampleDelta: 1024,
  sampleSizes: [8, 8],
  chunkOffsets: [270],
  samplesPerChunk: 2,
}

const tmcdTrack: SynthTrackSpec = {
  id: 3,
  handler: 'tmcd',
  format: 'tmcd',
  timescale: 30,
  sampleDelta: 1,
  sampleSizes: [4],
  chunkOffsets: [286],
  samplesPerChunk: 1,
}

async function remuxRoundTrip(tracks: SynthTrackSpec[], opts: { moovAtEnd?: boolean } = {}) {
  const payload = patternPayload(400)
  const { bytes, mdatPayloadStart } = buildMov({
    mdatPayload: payload,
    tracks,
    moovAtEnd: opts.moovAtEnd ?? true,
  })
  const input = asBlob(bytes)
  const movie = await parseMovie(input)
  const output = remux(movie, inspect(movie)).blob
  const reparsed = await parseMovie(output)
  return { input, inputMovie: movie, output, reparsed, inputMdatPayloadStart: mdatPayloadStart }
}

describe('remux', () => {
  it('produces a faststart MP4 and drops non-AV tracks', async () => {
    const { output, reparsed } = await remuxRoundTrip([videoTrack, aacTrack, tmcdTrack])
    expect(output.type).toBe('video/mp4')
    expect(reparsed.topLevel.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    expect(reparsed.majorBrand).toBe('isom')
    expect(reparsed.tracks.map((t) => t.handler)).toEqual(['vide', 'soun'])
  })

  it('relocated chunk offsets point at the identical media bytes', async () => {
    const { input, inputMovie, output, reparsed } = await remuxRoundTrip([videoTrack, aacTrack], {
      moovAtEnd: true,
    })
    for (let t = 0; t < reparsed.tracks.length; t++) {
      const oldTables = inputMovie.tracks[t]?.tables
      const newTables = reparsed.tracks[t]?.tables
      expect(newTables?.chunkOffsets.length).toBe(oldTables?.chunkOffsets.length)
      for (let i = 0; i < (oldTables?.chunkOffsets.length ?? 0); i++) {
        const oldBytes = await readBytes(input, oldTables?.chunkOffsets[i] ?? 0, 16)
        const newBytes = await readBytes(output, newTables?.chunkOffsets[i] ?? 0, 16)
        expect(newBytes).toEqual(oldBytes)
      }
    }
  })

  it('handles input that is already faststart (moov before mdat)', async () => {
    const { input, inputMovie, output, reparsed } = await remuxRoundTrip([videoTrack], {
      moovAtEnd: false,
    })
    const oldOffset = inputMovie.tracks[0]?.tables.chunkOffsets[0] ?? 0
    const newOffset = reparsed.tracks[0]?.tables.chunkOffsets[0] ?? 0
    expect(await readBytes(output, newOffset, 32)).toEqual(await readBytes(input, oldOffset, 32))
  })

  it('re-tags hev1 sample entries to hvc1', async () => {
    const { reparsed } = await remuxRoundTrip([{ ...videoTrack, format: 'hev1' }])
    expect(reparsed.tracks[0]?.stsdEntries[0]?.format).toBe('hvc1')
  })

  it('preserves co64 tables', async () => {
    const { reparsed } = await remuxRoundTrip([{ ...videoTrack, co64: true }])
    expect(reparsed.tracks[0]?.tables.co64).toBe(true)
  })

  it('preserves sample tables untouched apart from offsets', async () => {
    const { inputMovie, reparsed } = await remuxRoundTrip([videoTrack, aacTrack])
    const before = inputMovie.tracks[0]
    const after = reparsed.tracks[0]
    expect(after?.tables.sampleCount).toBe(before?.tables.sampleCount)
    expect(after?.tables.sampleSizes).toEqual(before?.tables.sampleSizes)
    expect(after?.tables.sttsDeltas).toEqual(before?.tables.sttsDeltas)
    expect(after?.timescale).toBe(before?.timescale)
  })
})
