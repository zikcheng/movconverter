import { describe, expect, it } from 'vitest'
import type { AudioSampleInfo } from '../src/box-reader'
import { UnsupportedFormatError } from '../src/errors'
import { pcmToF32, resolvePcmKind } from '../src/pcm'

function audio(overrides: Partial<AudioSampleInfo> = {}): AudioSampleInfo {
  return {
    stsdVersion: 0,
    channels: 2,
    sampleRate: 48000,
    bitsPerSample: 16,
    lpcmFlags: null,
    ...overrides,
  }
}

describe('resolvePcmKind', () => {
  it('maps the common camera formats', () => {
    expect(resolvePcmKind('sowt', audio())).toBe('s16le')
    expect(resolvePcmKind('twos', audio())).toBe('s16be')
    expect(resolvePcmKind('twos', audio({ bitsPerSample: 8 }))).toBe('s8')
    expect(resolvePcmKind('raw ', audio({ bitsPerSample: 8 }))).toBe('u8')
    expect(resolvePcmKind('in24', audio({ bitsPerSample: 24 }))).toBe('s24be')
    expect(resolvePcmKind('in32', audio({ bitsPerSample: 32 }))).toBe('s32be')
  })

  it('resolves lpcm via CoreAudio flags', () => {
    expect(
      resolvePcmKind('lpcm', audio({ stsdVersion: 2, bitsPerSample: 32, lpcmFlags: 0x1 })),
    ).toBe('f32le')
    expect(
      resolvePcmKind('lpcm', audio({ stsdVersion: 2, bitsPerSample: 32, lpcmFlags: 0x3 })),
    ).toBe('f32be')
    expect(
      resolvePcmKind('lpcm', audio({ stsdVersion: 2, bitsPerSample: 16, lpcmFlags: 0x4 })),
    ).toBe('s16le')
    expect(
      resolvePcmKind('lpcm', audio({ stsdVersion: 2, bitsPerSample: 24, lpcmFlags: 0x6 })),
    ).toBe('s24be')
  })

  it('rejects non-PCM formats', () => {
    expect(() => resolvePcmKind('mp4a', audio())).toThrow(UnsupportedFormatError)
  })
})

describe('pcmToF32', () => {
  it('converts s16le', () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x00, 0x00]) // -32768, 32767, 0
    const out = pcmToF32(bytes, 's16le')
    expect(out[0]).toBeCloseTo(-1)
    expect(out[1]).toBeCloseTo(32767 / 32768)
    expect(out[2]).toBe(0)
  })

  it('converts s16be (byte-swapped)', () => {
    const bytes = new Uint8Array([0x80, 0x00, 0x7f, 0xff])
    const out = pcmToF32(bytes, 's16be')
    expect(out[0]).toBeCloseTo(-1)
    expect(out[1]).toBeCloseTo(32767 / 32768)
  })

  it('converts u8 with 128 bias', () => {
    const out = pcmToF32(new Uint8Array([0, 128, 255]), 'u8')
    expect(out[0]).toBeCloseTo(-1)
    expect(out[1]).toBe(0)
    expect(out[2]).toBeCloseTo(127 / 128)
  })

  it('converts s24be', () => {
    const bytes = new Uint8Array([0x80, 0x00, 0x00, 0x7f, 0xff, 0xff])
    const out = pcmToF32(bytes, 's24be')
    expect(out[0]).toBeCloseTo(-1)
    expect(out[1]).toBeCloseTo(8388607 / 8388608)
  })

  it('passes through f32le', () => {
    const f = new Float32Array([0.5, -0.25])
    const bytes = new Uint8Array(f.buffer)
    const out = pcmToF32(bytes, 'f32le')
    expect(Array.from(out)).toEqual([0.5, -0.25])
  })

  it('ignores trailing partial samples', () => {
    const out = pcmToF32(new Uint8Array(5), 's16le')
    expect(out.length).toBe(2)
  })
})
