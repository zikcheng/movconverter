import { describe, expect, it } from 'vitest'
import { type AacEncoder, buildAacTrak, synthesizeAsc } from '../src/aac'
import { audioTranscode } from '../src/audio-path'
import { findBox, parseMovie } from '../src/box-reader'
import { dataView, readBytes } from '../src/bytes'
import { ConversionError } from '../src/errors'
import { inspect } from '../src/inspector'
import { asBlob, buildMov, type SynthTrackSpec } from './helpers/synth'

/** Emits one deterministic fake AAC frame per 1024 PCM frames consumed. */
function makeFakeEncoder(log: { totalValues: number } = { totalValues: 0 }): AacEncoder {
  return async (pcm, opts) => {
    for await (const f32 of pcm) log.totalValues += f32.length
    const frameCount = Math.max(1, Math.ceil(log.totalValues / opts.channels / 1024))
    const frames = Array.from({ length: frameCount }, (_, i) =>
      Uint8Array.from({ length: 6 + i }, (_, j) => (0xa0 + i + j) & 0xff),
    )
    return { frames, audioSpecificConfig: null }
  }
}

const videoTrack: SynthTrackSpec = {
  id: 1,
  handler: 'vide',
  format: 'avc1',
  timescale: 30000,
  sampleDelta: 1001,
  sampleSizes: [100, 80],
  chunkOffsets: [0],
  samplesPerChunk: 2,
}

// Stereo s16le PCM: each "sample" is one 4-byte frame, two chunks of two frames.
const pcmTrack: SynthTrackSpec = {
  id: 2,
  handler: 'soun',
  format: 'sowt',
  timescale: 48000,
  sampleDelta: 1,
  sampleSizes: [4, 4, 4, 4],
  chunkOffsets: [200, 208],
  samplesPerChunk: 2,
  audio: { channels: 2, bits: 16, rate: 48000 },
}

async function convert(tracks: SynthTrackSpec[], encoder: AacEncoder) {
  const payload = Uint8Array.from({ length: 400 }, (_, i) => i & 0xff)
  const { bytes } = buildMov({ mdatPayload: payload, tracks })
  const input = asBlob(bytes)
  const movie = await parseMovie(input)
  const plan = inspect(movie)
  expect(plan.method).toBe('audio-transcode')
  const output = (await audioTranscode(movie, plan, { encoder })).blob
  return { input, inputMovie: movie, output, reparsed: await parseMovie(output) }
}

describe('audioTranscode', () => {
  it('feeds the full PCM stream to the encoder as f32', async () => {
    const log = { totalValues: 0 }
    await convert([videoTrack, pcmTrack], makeFakeEncoder(log))
    // 4 frames x 2 channels = 8 interleaved values
    expect(log.totalValues).toBe(8)
  })

  it('produces an MP4 with a copied video track and a new mp4a track', async () => {
    const { reparsed } = await convert([videoTrack, pcmTrack], makeFakeEncoder())
    expect(reparsed.tracks.map((t) => t.handler)).toEqual(['vide', 'soun'])
    const audio = reparsed.tracks[1]
    expect(audio?.stsdEntries[0]?.format).toBe('mp4a')
    expect(audio?.timescale).toBe(48000)
    expect(audio?.tables.sttsDeltas[0]).toBe(1024)
    expect(audio?.trackId).toBe(2)
  })

  it('audio chunk offset points at the encoded frames', async () => {
    const { output, reparsed } = await convert([videoTrack, pcmTrack], makeFakeEncoder())
    const audio = reparsed.tracks[1]
    const offset = audio?.tables.chunkOffsets[0] ?? 0
    const firstFrameSize = audio?.tables.sampleSizes?.[0] ?? 0
    expect(firstFrameSize).toBe(6)
    const stored = await readBytes(output, offset, firstFrameSize)
    expect(Array.from(stored)).toEqual([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5])
  })

  it('video media bytes survive untouched', async () => {
    const { input, inputMovie, output, reparsed } = await convert(
      [videoTrack, pcmTrack],
      makeFakeEncoder(),
    )
    const oldOffset = inputMovie.tracks[0]?.tables.chunkOffsets[0] ?? 0
    const newOffset = reparsed.tracks[0]?.tables.chunkOffsets[0] ?? 0
    expect(await readBytes(output, newOffset, 180)).toEqual(await readBytes(input, oldOffset, 180))
  })

  it('writes a priming edit list on the audio track', async () => {
    const { reparsed } = await convert([videoTrack, pcmTrack], makeFakeEncoder())
    const audio = reparsed.tracks[1]
    const moovBytes = reparsed.moovBytes
    const edts = findBox(moovBytes, (audio?.trakStart ?? 0) + 8, audio?.trakEnd ?? 0, 'edts')
    expect(edts).not.toBeNull()
    const elst = findBox(moovBytes, (edts?.start ?? 0) + 8, edts?.end ?? 0, 'elst')
    expect(elst).not.toBeNull()
    const p = (elst?.start ?? 0) + 8
    const dv = dataView(moovBytes)
    expect(dv.getUint32(p + 4)).toBe(1) // entry count
    expect(dv.getUint32(p + 12)).toBe(2112) // media time = priming samples
  })

  it('rejects being called with a remux plan', async () => {
    const payload = new Uint8Array(400)
    const { bytes } = buildMov({ mdatPayload: payload, tracks: [videoTrack] })
    const movie = await parseMovie(asBlob(bytes))
    await expect(audioTranscode(movie, inspect(movie))).rejects.toThrow(ConversionError)
  })
})

describe('buildAacTrak', () => {
  it('generates a parseable trak with a patchable stco entry', () => {
    const result = buildAacTrak({
      trackId: 5,
      sampleRate: 44100,
      channels: 2,
      asc: synthesizeAsc(44100, 2),
      sampleSizes: [120, 130, 140],
      movieTimescale: 600,
      primingSamples: 2112,
    })
    const dv = dataView(result.bytes)
    expect(dv.getUint32(result.stcoEntryPos)).toBe(0)
    // 3 frames * 1024 samples - priming, in movie timescale
    const expected = Math.round(((3 * 1024 - 2112) / 44100) * 600)
    expect(result.trackDurationMovieTs).toBe(expected)
  })
})

describe('synthesizeAsc', () => {
  it('encodes AAC-LC object type, frequency index and channels', () => {
    // objectType 2, freqIndex 3 (48000), channels 2 => 0001 0001 1001 0000
    expect(Array.from(synthesizeAsc(48000, 2))).toEqual([0x11, 0x90])
    expect(Array.from(synthesizeAsc(44100, 1))).toEqual([0x12, 0x08])
  })

  it('rejects unmappable sample rates', () => {
    expect(() => synthesizeAsc(12345, 2)).toThrow(ConversionError)
  })
})
