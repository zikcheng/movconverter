import { describe, expect, it } from 'vitest'
import { findBox, iterBoxes } from '../src/box-reader'
import { dataView, fourcc } from '../src/bytes'
import { box, buildFtyp, fullBox, largeBox, u32 } from '../src/mp4-writer'

describe('box serialization', () => {
  it('writes size and type that the reader round-trips', () => {
    const bytes = box('moov', box('mvhd', u32(1, 2, 3)), box('trak', new Uint8Array(4)))
    const children = [...iterBoxes(bytes, 8, bytes.length)]
    expect(children.map((c) => c.type)).toEqual(['mvhd', 'trak'])
    expect(findBox(bytes, 8, bytes.length, 'trak')?.size).toBe(12)
  })

  it('writes 64-bit extended sizes that the reader round-trips', () => {
    const bytes = largeBox('mdat', new Uint8Array(32))
    const dv = dataView(bytes)
    expect(dv.getUint32(0)).toBe(1)
    expect(fourcc(bytes, 4)).toBe('mdat')
    expect(Number(dv.getBigUint64(8))).toBe(bytes.length)
    const [parsed] = [...iterBoxes(bytes, 0, bytes.length)]
    expect(parsed).toMatchObject({ type: 'mdat', size: 48, headerSize: 16 })
  })

  it('writes full box version and flags', () => {
    const bytes = fullBox('stss', 1, 0x000102, u32(0))
    const dv = dataView(bytes)
    expect(dv.getUint8(8)).toBe(1)
    expect(dv.getUint32(8) & 0xffffff).toBe(0x000102)
  })
})

describe('buildFtyp', () => {
  it('builds an isom ftyp with compatible brands', () => {
    const bytes = buildFtyp()
    expect(fourcc(bytes, 4)).toBe('ftyp')
    expect(fourcc(bytes, 8)).toBe('isom')
    expect(fourcc(bytes, 16)).toBe('isom')
    expect(bytes.length).toBe(8 + 4 + 4 + 5 * 4)
  })

  it('accepts custom brands', () => {
    const bytes = buildFtyp({ majorBrand: 'mp42', compatibleBrands: ['mp42'] })
    expect(fourcc(bytes, 8)).toBe('mp42')
    expect(bytes.length).toBe(8 + 4 + 4 + 4)
  })
})
