import { describe, expect, it } from 'vitest'
import { parseMovie } from '../src/box-reader'
import { UnsupportedFormatError } from '../src/errors'
import { inspect } from '../src/inspector'
import { asBlob, buildMov, type SynthTrackSpec } from './helpers/synth'

function track(overrides: Partial<SynthTrackSpec>): SynthTrackSpec {
  return {
    id: 1,
    handler: 'vide',
    format: 'avc1',
    timescale: 30000,
    sampleDelta: 1001,
    sampleSizes: [100],
    chunkOffsets: [0],
    samplesPerChunk: 1,
    ...overrides,
  }
}

async function planFor(tracks: SynthTrackSpec[]) {
  const { bytes } = buildMov({ mdatPayload: new Uint8Array(400), tracks })
  return inspect(await parseMovie(asBlob(bytes)))
}

describe('inspect', () => {
  it('plans a pure remux for H.264 + AAC', async () => {
    const plan = await planFor([
      track({ id: 1, format: 'avc1' }),
      track({ id: 2, handler: 'soun', format: 'mp4a', timescale: 48000, sampleDelta: 1024 }),
    ])
    expect(plan.method).toBe('remux')
    expect(plan.video).toEqual({ trackId: 1, format: 'avc1', action: 'copy' })
    expect(plan.audio).toEqual({ trackId: 2, format: 'mp4a', action: 'copy' })
    expect(plan.dropped).toEqual([])
  })

  it('plans remux with re-tag for hev1 HEVC', async () => {
    const plan = await planFor([track({ format: 'hev1' })])
    expect(plan.method).toBe('remux')
    expect(plan.video?.action).toBe('copy-retag')
  })

  it('plans audio transcode for camera files (H.264 + PCM)', async () => {
    const plan = await planFor([
      track({ id: 1, format: 'avc1' }),
      track({
        id: 2,
        handler: 'soun',
        format: 'sowt',
        timescale: 48000,
        sampleDelta: 1,
        audio: { channels: 2, bits: 16, rate: 48000 },
      }),
    ])
    expect(plan.method).toBe('audio-transcode')
    expect(plan.audio?.action).toBe('webcodecs')
  })

  it('plans full transcode for ProRes', async () => {
    const plan = await planFor([track({ format: 'apcn' })])
    expect(plan.method).toBe('full-transcode')
    expect(plan.video?.action).toBe('wasm')
  })

  it('plans full transcode for unknown video formats (conservative)', async () => {
    const plan = await planFor([track({ format: 'zzzz' })])
    expect(plan.method).toBe('full-transcode')
  })

  it('plans full transcode when audio is compressed but not AAC', async () => {
    const plan = await planFor([
      track({ id: 1, format: 'avc1' }),
      track({ id: 2, handler: 'soun', format: 'ulaw', timescale: 8000, sampleDelta: 1 }),
    ])
    expect(plan.method).toBe('full-transcode')
    expect(plan.audio?.action).toBe('wasm')
  })

  it('drops timecode tracks and extra streams', async () => {
    const plan = await planFor([
      track({ id: 1, format: 'avc1' }),
      track({ id: 2, format: 'avc1' }),
      track({ id: 3, handler: 'tmcd', format: 'tmcd', timescale: 30, sampleDelta: 1 }),
    ])
    expect(plan.method).toBe('remux')
    expect(plan.dropped).toEqual([
      { trackId: 2, handler: 'vide', format: 'avc1' },
      { trackId: 3, handler: 'tmcd', format: 'tmcd' },
    ])
  })

  it('rejects files with neither audio nor video', async () => {
    await expect(
      planFor([track({ handler: 'tmcd', format: 'tmcd', timescale: 30, sampleDelta: 1 })]),
    ).rejects.toThrow(UnsupportedFormatError)
  })
})
