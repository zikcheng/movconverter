import { describe, expect, it } from 'vitest'
import { listTopLevelBoxes, parseMovie } from '../src/box-reader'
import { MovParseError, UnsupportedFormatError } from '../src/errors'
import { asBlob, box, buildMov, type SynthTrackSpec, u32 } from './helpers/synth'

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

const audioTrack: SynthTrackSpec = {
  id: 2,
  handler: 'soun',
  format: 'sowt',
  timescale: 48000,
  sampleDelta: 1,
  sampleSizes: [4, 4, 4],
  chunkOffsets: [270],
  samplesPerChunk: 3,
  audio: { channels: 2, bits: 16, rate: 48000 },
}

const tmcdTrack: SynthTrackSpec = {
  id: 3,
  handler: 'tmcd',
  format: 'tmcd',
  timescale: 30,
  sampleDelta: 1,
  sampleSizes: [4],
  chunkOffsets: [282],
  samplesPerChunk: 1,
}

describe('listTopLevelBoxes', () => {
  it('scans ftyp/mdat/moov in order', async () => {
    const { bytes } = buildMov({ mdatPayload: new Uint8Array(300), tracks: [videoTrack] })
    const boxes = await listTopLevelBoxes(asBlob(bytes))
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov'])
    expect(boxes[2]?.end).toBe(bytes.length)
  })

  it('rejects a box that extends beyond EOF', async () => {
    const bad = box('mdat', new Uint8Array(10)).slice(0, 12)
    await expect(listTopLevelBoxes(asBlob(bad))).rejects.toThrow(MovParseError)
  })
})

describe('parseMovie', () => {
  it('parses tracks, handlers and sample tables (moov at end)', async () => {
    const { bytes, mdatPayloadStart } = buildMov({
      mdatPayload: new Uint8Array(300),
      tracks: [videoTrack, audioTrack, tmcdTrack],
    })
    const movie = await parseMovie(asBlob(bytes))

    expect(movie.majorBrand).toBe('qt  ')
    expect(movie.movieTimescale).toBe(600)
    expect(movie.tracks).toHaveLength(3)

    const [video, audio, tmcd] = movie.tracks
    expect(video?.handler).toBe('vide')
    expect(video?.trackId).toBe(1)
    expect(video?.timescale).toBe(30000)
    expect(video?.stsdEntries[0]?.format).toBe('avc1')
    expect(Array.from(video?.tables.sampleSizes ?? [])).toEqual([100, 80, 90])
    expect(video?.tables.sampleCount).toBe(3)
    expect(video?.tables.chunkOffsets[0]).toBe(mdatPayloadStart)
    expect(video?.tables.stss).not.toBeNull()

    expect(audio?.handler).toBe('soun')
    expect(audio?.stsdEntries[0]?.format).toBe('sowt')
    expect(audio?.audio).toEqual({
      stsdVersion: 0,
      channels: 2,
      bitsPerSample: 16,
      sampleRate: 48000,
    })
    expect(audio?.tables.chunkOffsets[0]).toBe(mdatPayloadStart + 270)

    expect(tmcd?.handler).toBe('tmcd')
  })

  it('parses a file with moov before mdat (faststart layout)', async () => {
    const { bytes, mdatPayloadStart } = buildMov({
      moovAtEnd: false,
      mdatPayload: new Uint8Array(300),
      tracks: [videoTrack],
    })
    const movie = await parseMovie(asBlob(bytes))
    expect(movie.topLevel.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    expect(movie.tracks[0]?.tables.chunkOffsets[0]).toBe(mdatPayloadStart)
  })

  it('parses co64 chunk offsets and 64-bit mdat sizes', async () => {
    const { bytes, mdatPayloadStart } = buildMov({
      largeMdat: true,
      mdatPayload: new Uint8Array(300),
      tracks: [{ ...videoTrack, co64: true }],
    })
    const movie = await parseMovie(asBlob(bytes))
    const track = movie.tracks[0]
    expect(track?.tables.co64).toBe(true)
    expect(track?.tables.chunkOffsets[0]).toBe(mdatPayloadStart)
  })

  it('rejects an empty blob', async () => {
    await expect(parseMovie(new Blob([]))).rejects.toThrow(MovParseError)
  })

  it('rejects a file without moov', async () => {
    const bytes = box('mdat', new Uint8Array(32))
    await expect(parseMovie(asBlob(bytes))).rejects.toThrow(/moov/)
  })

  it('rejects compressed moov (cmov)', async () => {
    const moovWithCmov = box('moov', box('cmov', new Uint8Array(8)))
    await expect(parseMovie(asBlob(moovWithCmov))).rejects.toThrow(UnsupportedFormatError)
  })

  it('reports malformed child boxes with context', async () => {
    // moov whose child claims a size larger than its parent
    const badChild = box('moov', u32(9999), new Uint8Array(8))
    await expect(parseMovie(asBlob(badChild))).rejects.toThrow(MovParseError)
  })
})
