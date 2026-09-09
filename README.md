# movconverter

Browser-only MOV → MP4 conversion. No server, no upload — files never leave the user's machine.

- **Zero config**: detects the codecs inside the MOV and picks the fastest path automatically
- **Lossless & instant** for the most common case: iPhone/Mac footage (H.264/HEVC + AAC) is remuxed, not re-encoded — a 1GB file takes seconds and no wasm is loaded
- **Large-file safe**: streaming design with constant memory usage, independent of file size

> Status: under active development, not yet published.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the technical design.

## License

MIT
