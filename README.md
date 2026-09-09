# movconverter

Browser-only MOV → MP4 conversion. No server, no upload — files never leave the user's machine.

- **Zero config**: detects the codecs inside the MOV and picks the fastest path automatically
- **Lossless & instant** for the most common case: iPhone/Mac footage (H.264/HEVC + AAC) is remuxed, not re-encoded — no wasm, constant memory, a 1GB file takes about as long as reading it from disk
- **Camera footage** (H.264 + PCM audio): video is copied verbatim, only the audio is re-encoded to AAC through the browser's native WebCodecs encoder
- **Large-file safe**: streaming design; memory usage does not grow with file size

> Status: pre-release. The remux and audio-transcode paths are implemented; full transcoding (ProRes, MJPEG) is planned via a separate lazy-loaded wasm package.

## Usage

```ts
import { convertMovToMp4 } from 'movconverter'

const { blob, method } = await convertMovToMp4(file, {
  onProgress: (p) => console.log(`${Math.round(p * 100)}%`),
})
// method is 'remux' | 'audio-transcode' | 'full-transcode' — show it off:
// 'remux' means the conversion was lossless and instant.
```

### Preflight

Ask what would happen before converting (cheap — only the file's metadata is read):

```ts
import { canConvert } from 'movconverter'

const plan = await canConvert(file)
plan.method   // 'remux' | 'audio-transcode' | 'full-transcode'
plan.video    // { trackId, format: 'hvc1', action: 'copy' } ...
plan.dropped  // tracks MP4 cannot carry (timecode, ...), reported not errored
```

### Off the main thread

```ts
import { convertInWorker } from 'movconverter'

const worker = new Worker(new URL('movconverter/worker', import.meta.url), { type: 'module' })
const result = await convertInWorker(worker, file, { onProgress })
```

### Cancellation

```ts
const controller = new AbortController()
convertMovToMp4(file, { signal: controller.signal })
controller.abort()
```

## How it works

MOV (QuickTime) is the direct ancestor of MP4 — both are ISO BMFF box structures. When
the codecs inside are MP4-compatible, conversion is a container rewrite: build a new
`ftyp`, rewrite `moov` (dropping what MP4 can't carry, re-tagging `hev1` → `hvc1`,
preserving rotation and color metadata), shift the chunk-offset tables, and reference
the media bytes as lazy Blob slices. Nothing is decoded, nothing is copied through
memory, and the output is faststart (moov first).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## Browser support

- Remux path: any browser with `Blob` (everything current)
- Audio-transcode path: needs WebCodecs `AudioEncoder` with AAC (Chrome/Edge, Safari 16.4+; use `isWebCodecsAacSupported()` to check)

## License

MIT
