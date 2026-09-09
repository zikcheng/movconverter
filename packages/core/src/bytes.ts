/** Read a byte range from a Blob. Returns fewer bytes than requested at EOF. */
export async function readBytes(blob: Blob, start: number, length: number): Promise<Uint8Array> {
  const end = Math.min(start + length, blob.size)
  if (end <= start) return new Uint8Array(0)
  const buf = await blob.slice(start, end).arrayBuffer()
  return new Uint8Array(buf)
}

/** Decode a 4-byte ASCII identifier (box type / codec fourcc). */
export function fourcc(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  )
}

export function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/** Growable big-endian byte writer used for box serialization. */
export class ByteWriter {
  private buf: Uint8Array
  private view: DataView
  private len = 0

  constructor(initialCapacity = 1024) {
    this.buf = new Uint8Array(initialCapacity)
    this.view = dataView(this.buf)
  }

  get length(): number {
    return this.len
  }

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.len + extra) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
    this.view = dataView(this.buf)
  }

  u8(v: number): this {
    this.ensure(1)
    this.view.setUint8(this.len, v)
    this.len += 1
    return this
  }

  u16(v: number): this {
    this.ensure(2)
    this.view.setUint16(this.len, v)
    this.len += 2
    return this
  }

  u32(v: number): this {
    this.ensure(4)
    this.view.setUint32(this.len, v)
    this.len += 4
    return this
  }

  u64(v: number | bigint): this {
    this.ensure(8)
    this.view.setBigUint64(this.len, BigInt(v))
    this.len += 8
    return this
  }

  f64(v: number): this {
    this.ensure(8)
    this.view.setFloat64(this.len, v)
    this.len += 8
    return this
  }

  fourcc(s: string): this {
    if (s.length !== 4) throw new Error(`fourcc must be 4 chars, got '${s}'`)
    this.ensure(4)
    for (let i = 0; i < 4; i++) this.view.setUint8(this.len + i, s.charCodeAt(i))
    this.len += 4
    return this
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
    return this
  }

  zeros(n: number): this {
    this.ensure(n)
    this.buf.fill(0, this.len, this.len + n)
    this.len += n
    return this
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}
