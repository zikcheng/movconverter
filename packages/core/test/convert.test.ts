import { describe, expect, it } from 'vitest'
import type { AacEncoder } from '../src/aac'
import { canConvert, convertMovToMp4 } from '../src/convert'
import { UnsupportedFormatError } from '../src/errors'
import { asBlob, buildMov, type SynthTrackSpec } from './helpers/synth'

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

const pcmTrack: SynthTrackSpec = {
  id: 2,
  handler: 'soun',
  format: 'sowt',
  timescale: 48000,
  sampleDelta: 1,
  sampleSizes: [4, 4],
  chunkOffsets: [200],
  samplesPerChunk: 2,
  audio: { channels: 2, bits: 16, rate: 48000 },
}

const fakeEncoder: AacEncoder = async (pcm) => {
  for await (const _ of pcm) {
    // drain
  }
  return { frames: [new Uint8Array([1, 2, 3])], audioSpecificConfig: null }
}

function fileWith(tracks: SynthTrackSpec[]): Blob {
  return asBlob(buildMov({ mdatPayload: new Uint8Array(400), tracks }).bytes)
}

describe('canConvert', () => {
  it('returns the plan without converting', async () => {
    const plan = await canConvert(fileWith([videoTrack]))
    expect(plan.method).toBe('remux')
  })
})

describe('convertMovToMp4', () => {
  it('dispatches to remux and reports progress 1', async () => {
    let progress = 0
    const result = await convertMovToMp4(fileWith([videoTrack]), {
      onProgress: (p) => {
        progress = p
      },
    })
    expect(result.method).toBe('remux')
    expect(result.blob.type).toBe('video/mp4')
    expect(progress).toBe(1)
  })

  it('dispatches to the audio-transcode path', async () => {
    const result = await convertMovToMp4(fileWith([videoTrack, pcmTrack]), {
      aacEncoder: fakeEncoder,
    })
    expect(result.method).toBe('audio-transcode')
    expect(result.plan.audio?.action).toBe('webcodecs')
  })

  it('throws a descriptive error for full-transcode files', async () => {
    await expect(convertMovToMp4(fileWith([{ ...videoTrack, format: 'apcn' }]))).rejects.toThrow(
      UnsupportedFormatError,
    )
    await expect(convertMovToMp4(fileWith([{ ...videoTrack, format: 'apcn' }]))).rejects.toThrow(
      /apcn/,
    )
  })

  it('honors a pre-aborted signal', async () => {
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await expect(
      convertMovToMp4(fileWith([videoTrack]), { signal: controller.signal }),
    ).rejects.toThrow('user cancelled')
  })
})
