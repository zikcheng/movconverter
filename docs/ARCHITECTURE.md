# movconverter — Architecture and Technical Roadmap

> This document is the project's technical decision record (finalized 2026-09). Update it before changing the core architecture.

## 1. Positioning

**A browser-only MOV → MP4 conversion library.** Data never leaves the machine, no upload wait, zero server cost — the space that server-side conversion SaaS like CloudConvert / FreeConvert (both server-side ffmpeg farms; the browser only uploads) cannot cover.

Core value proposition:

1. Zero config: `convert(file)` auto-detects codecs and picks the fastest path
2. Most real-world files (produced by iPhone/Mac) finish **losslessly in seconds**, loading no wasm at all
3. Large-file friendly: the primary paths use constant memory, independent of file size

## 2. Format Background (Why This Works)

MOV (QuickTime File Format, Apple 1991) is the ancestor of MP4 (ISO BMFF, standardized from QTFF in 2001). Both share the box/atom structure (`ftyp`/`moov`/`mdat`). Therefore:

- Container conversion ≠ re-encoding. When the inner codecs are MP4-compatible (H.264/HEVC + AAC), only the container metadata needs rewriting (remux) — lossless and extremely fast
- Real transcoding is only needed for codecs MP4 does not support (ProRes, MJPEG, PCM audio, …)

### Real-World MOV Sources and Codec Distribution

| Source | Typical codecs | Path |
|---|---|---|
| iPhone / iPad / Mac (screen recording, iMovie/FCP exports) | H.264/HEVC + AAC | Tier 1: pure remux |
| Cameras (Canon/Nikon/Fujifilm, …) | H.264 + **PCM** | Tier 2: video copy + audio → AAC |
| Professional production (Premiere/AE/DaVinci exports, cinema cameras) | ProRes / DNxHD / Animation | Tier 3: full transcode |
| Legacy digital cameras | MJPEG + PCM/μ-law | Tier 3 + fault-tolerant parsing |

## 3. Three-Tier Path Architecture

After codec detection, the cheapest viable path is chosen automatically:

### Tier 1: Pure JS remux (flagship path, highest-frequency case)

Rewrite moov, move mdat verbatim. No wasm, no WebCodecs; a 1GB file takes roughly disk-IO time.

1. New `ftyp`: brand `qt  ` → `isom/mp42`
2. moov rewrite: drop tracks/boxes MP4 does not accept (`tmcd` timecode tracks, Apple-private udta entries); `hev1` → `hvc1`; **must preserve** the `tkhd` rotation matrix (portrait video) and `colr` color info (HDR)
3. Fix chunk offsets: the new moov's size is computable up front (all sample tables are fixed-length structures), so moov goes at the file head for faststart; all `stco/co64` offsets shift by a single delta
4. mdat is streamed via `Blob.slice()` → `WritableStream`, never through memory

### Tier 2: Video copy + WebCodecs audio transcode (camera files)

PCM needs no decoder — pull raw samples out of mdat via the sample tables, convert byte order (`sowt` little-endian / `twos` big-endian) to f32, feed the browser's native `AudioEncoder` to produce AAC, rebuild the audio track's sample tables, and interleave chunks with the video track. An order of magnitude faster than a full transcode.

- Handle AAC encoder priming delay with an `elst` (edit list) to keep A/V sync
- Browsers whose `AudioEncoder` lacks AAC fall back to Tier 3

### Tier 3: wasm full transcode (ProRes/MJPEG fallback)

Browsers have no ProRes/MJPEG decoders, so wasm is required. **Lazy-loaded**: a separate subpackage, dynamically `import()`ed only when detection says it is needed — 95% of users must not pay a ~30MB download for 5% of files.

Evolution stages in §5 (roadmap).

## 4. Module Design

```
packages/core        Main package, zero runtime deps, target gzip 15–25KB
├── box-reader       Streaming ISO BMFF parser (on-demand reads via Blob.slice)
├── inspector        Codec detection + path decision
├── mp4-writer       MP4 muxer (box serialization + sample table construction)
├── remuxer          Tier 1
├── audio-path       Tier 2
└── worker           All logic runs in a Web Worker; the main thread is a thin shell

packages/wasm        Tier 3, published separately, lazy-loaded
```

### box-reader essentials

- Never read the whole file into memory. Read the 8-byte box header (size + type) via `Blob.slice`, then descend or skip; only the moov subtree is actually parsed (typically hundreds of KB to a few MB), mdat is recorded as offsets only
- Find moov at either end: faststart files have it at the head, camera files at the tail
- Must support 64-bit variants: `co64`, and 8-byte extended size when box size == 1
- Core parsing chain: `moov → trak → mdia → minf → stbl`, with six sample tables: `stsd` (codec), `stts` (timestamps), `stss` (keyframes), `stsc` (sample→chunk), `stsz` (sizes), `stco/co64` (offsets)

### inspector decision table

| stsd fourcc | Meaning | Decision |
|---|---|---|
| `avc1` / `hvc1` | H.264 / HEVC | video copy |
| `hev1` | HEVC alternate packaging | copy, rewrite stsd to `hvc1` |
| `ap4h` `apch` `apcn` `apcs` `apco` | ProRes family | wasm |
| `jpeg` / `mjpa` / `mjpb` | MJPEG | wasm |
| `mp4a` | AAC | audio copy |
| `sowt` / `twos` / `lpcm` / `in24` / `in32` | PCM variants | WebCodecs → AAC |
| `tmcd` / `text` etc. | timecode/subtitle tracks | drop, report in result |

Output decision object: `{ video: 'copy'|'wasm', audio: 'copy'|'webcodecs'|'wasm', dropped: [...] }` — also the basis of the public `canConvert()` API result.

### Public API shape

```ts
const { blob, method } = await convertMovToMp4(file, {
  onProgress: (p: number) => {},          // 0-1
  signal: abortController.signal,
  quality: 'copy' | 'high' | 'medium',    // transcode paths only
});
// method: 'remux' | 'audio-transcode' | 'full-transcode'

const plan = await canConvert(file);
// Preflight: path, estimated duration class, output size estimate, disk quota check
```

## 5. Large-File Strategy (Core Competitive Advantage)

Tiers 1–2 use constant memory (only moov is ever held in memory — a two-hour 4K recording needs just tens of MB) and scale to tens of GB. Tier 3 is the only bottleneck (wasm32 memory wall ≈ 2GB), solved in stages:

- **1.0**: Tiers 1 + 2, plus whole-file ffmpeg.wasm fallback (input mounted via WORKERFS; output capped at ≤2GB, with `canConvert()` preflight rejecting oversized files up front)
- **1.x**: **Segmented transcoding + resumability.** The codecs that need wasm (ProRes/MJPEG/DNxHD) happen to be all-intra, so cutting at any frame is safe — split by time, transcode segment by segment into OPFS, keep a manifest for resume-after-interruption, then concatenate via remux. Breaks the 2GB ceiling
- **2.0**: **Frame-level pipeline**, unifying the architecture: a custom Emscripten-built, trimmed libavcodec (ProRes/MJPEG decoders only, 2–3MB) decodes frame by frame → `VideoFrame` → hardware encoding via WebCodecs `VideoEncoder`. Memory is independent of file size (3–5 frames in flight), 5–10× faster than wasm software encoding, and the file-size limit becomes the user's disk space

### Large-file engineering rules (all code must comply)

1. No path may read the entire input file into an ArrayBuffer
2. Output >4GB must use `co64` and 64-bit mdat sizes (32-bit tables on a large file = silent data corruption)
3. In workers, use OPFS via `createSyncAccessHandle` exclusively (Safari's `createWritable` support came late)
4. Check disk quota with `navigator.storage.estimate()` before converting (peak ≈ input + output)
5. Acquire a `WakeLock` for long jobs; flush segment results to disk immediately to support resuming
6. Delivery: on Chromium prefer `showSaveFilePicker` writing straight to disk; Safari is unreliable with very large Blob downloads — cap or segment there

## 6. Known Domain Pitfalls (check here before debugging)

- **Rotation matrix**: iPhone portrait rotation lives in the `tkhd` matrix; lose it and the video lies sideways
- **HEVC tag**: MP4 requires `hvc1`; writing `hev1` breaks Safari/QuickTime playback
- **HDR**: dropping `colr`/Dolby Vision metadata → washed-out picture
- **Alpha**: ProRes 4444 transparency is necessarily lost going to H.264 — warn at the API level, never silently
- **AAC priming**: without `elst` correction, audio drifts out of sync
- **Malformed legacy files**: nonstandard box structures are common in old-camera output — parse defensively and collect real samples for regression

## 7. Testing Strategy

The fixture library is a first-class citizen. Keep real files for each of the four source categories:

1. iPhone (H.264, HEVC, HDR, portrait, >4GB long recordings)
2. Mac screen recordings / FCP exports
3. Cameras (mainly Canon H.264+PCM)
4. Professional formats (ProRes profiles, with alpha) + legacy-camera MJPEG

Unit tests use minimal synthetic box structures generated in code; integration tests run real samples (large samples are not committed — CI fetches them by script).

## 8. Implementation Status and Known Limitations (updated 2026-09)

Implemented in `packages/core`: box-reader, inspector, mp4-writer primitives, Tier 1
remuxer (faststart output, hev1→hvc1 re-tag, lossless-verified against ffmpeg),
Tier 2 audio path (PCM extraction for sowt/twos/raw/in24/in32/lpcm, pluggable AAC
encoder with WebCodecs default, priming elst), public `convertMovToMp4`/`canConvert`
API, worker entry + client protocol.

Known limitations to revisit:

1. **Tier 2 leaves the original PCM bytes unreferenced** inside the copied mdat
   (~10–15% size overhead on camera files). Trimming requires chunk-level mdat
   rewriting — planned.
2. **stco → co64 upgrade is not implemented**: if relocation pushes a 32-bit chunk
   offset past 4GB (only possible for ~4GB inputs right at the boundary), conversion
   fails with a clear error instead of writing a corrupt file. Same for the Tier 2
   audio chunk offset.
3. **Tier 3 (full transcode) throws `UnsupportedFormatError`** — the wasm subpackage
   is the next milestone (see §5 roadmap).
4. Only the first video and first audio track are kept; extras are dropped and
   reported in the plan.

## 9. Ecosystem References

- `mediabunny` (MPL-2.0): the closest general-purpose browser media library. **This project deliberately does not depend on it** — a custom kernel buys minimal size and MOV→MP4 domain depth
- `mp4box.js` (BSD-3): reference implementation for box parsing
- `@ffmpeg/ffmpeg` 0.12.x: basis of the Tier 3 implementation in 1.0
- Browser baseline (2026): WebCodecs (Chrome/Edge, Safari 16.4+, Firefox 130+), OPFS, and streaming `Blob.slice` reads are all stable
