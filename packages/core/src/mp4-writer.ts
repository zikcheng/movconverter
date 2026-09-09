import { ByteWriter } from './bytes'

/** Serialize a box: 32-bit size + type + payload parts. */
export function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payloadSize = parts.reduce((n, p) => n + p.length, 0)
  const w = new ByteWriter(8 + payloadSize)
  w.u32(8 + payloadSize).fourcc(type)
  for (const p of parts) w.bytes(p)
  return w.toUint8Array()
}

/** Serialize a box with a 64-bit extended size header. */
export function largeBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payloadSize = parts.reduce((n, p) => n + p.length, 0)
  const w = new ByteWriter(16 + payloadSize)
  w.u32(1)
    .fourcc(type)
    .u64(16 + payloadSize)
  for (const p of parts) w.bytes(p)
  return w.toUint8Array()
}

/** Serialize a full box (1-byte version + 3-byte flags prefix). */
export function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Uint8Array[]
): Uint8Array {
  const vf = new ByteWriter(4)
    .u8(version)
    .u8(flags >> 16)
    .u8((flags >> 8) & 0xff)
    .u8(flags & 0xff)
  return box(type, vf.toUint8Array(), ...parts)
}

export function u16(...values: number[]): Uint8Array {
  const w = new ByteWriter(values.length * 2)
  for (const v of values) w.u16(v)
  return w.toUint8Array()
}

export function u32(...values: number[]): Uint8Array {
  const w = new ByteWriter(values.length * 4)
  for (const v of values) w.u32(v)
  return w.toUint8Array()
}

export function u64(...values: number[]): Uint8Array {
  const w = new ByteWriter(values.length * 8)
  for (const v of values) w.u64(v)
  return w.toUint8Array()
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const w = new ByteWriter(
    Math.max(
      1,
      parts.reduce((n, p) => n + p.length, 0),
    ),
  )
  for (const p of parts) w.bytes(p)
  return w.toUint8Array()
}

export interface FtypOptions {
  majorBrand?: string
  minorVersion?: number
  compatibleBrands?: string[]
}

/** Build the ftyp box for MP4 output. */
export function buildFtyp(opts: FtypOptions = {}): Uint8Array {
  const major = opts.majorBrand ?? 'isom'
  const minor = opts.minorVersion ?? 0x200
  const brands = opts.compatibleBrands ?? ['isom', 'iso2', 'avc1', 'mp41', 'mp42']
  const w = new ByteWriter().fourcc(major).u32(minor)
  for (const b of brands) w.fourcc(b)
  return box('ftyp', w.toUint8Array())
}
