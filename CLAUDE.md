# CLAUDE.md

## Project Overview

**movconverter** — a browser-only MOV → MP4 conversion library, published to npm. Core value: automatically detects the codec and picks the fastest path; iPhone/Mac files convert losslessly in seconds via pure remuxing (no wasm); memory usage stays constant regardless of file size.

**Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing any core code** — the three-tier path architecture, module design, large-file rules, and the list of domain-specific pitfalls all live there; this file does not repeat them.

## Repository Layout

```
packages/core    Main package `movconverter`: zero runtime deps, gzip ≤25KB, pure TS
packages/wasm    @movconverter/wasm: tier-3 fallback, lazy-loaded, versioned independently
docs/            Architecture and design docs
fixtures/        Test samples (large files are not committed; fetched by script)
```

## Stack and Tooling

- TypeScript (strict), ESM only, target ES2022+
- pnpm workspaces (monorepo)
- Build: tsup; tests: vitest (browser tests via `@vitest/browser` + Playwright)
- Lint/format: Biome
- Versioning and changelog: Changesets
- CI: GitHub Actions

## Common Commands

```bash
pnpm install          # install dependencies
pnpm build            # build all packages
pnpm test             # unit tests
pnpm test:browser     # browser integration tests (real samples)
pnpm lint             # Biome checks
pnpm changeset        # record a change (required for every user-visible change)
```

(Until scaffolding is complete some of these may not exist yet; keep this section in sync with package.json scripts.)

## Hard Coding Rules

1. **The core package has zero runtime dependencies.** Adding any dependency requires justification in the PR
2. **Never read the entire input file into memory** — everything streams via `Blob.slice` (see ARCHITECTURE.md §5, large-file rules)
3. All conversion logic runs in a Web Worker; the main-thread API is a thin message shell
4. Output files >4GB must use `co64` and 64-bit mdat sizes
5. Public API changes must update type exports and the README together; breaking changes require a major version
6. Binary parsing code must tolerate malformed input: throw contextual custom errors (`MovParseError` etc.); no bare throws, no silently swallowed errors

## Testing Requirements

- Unit tests: minimal synthetic box structures generated in code, covering 64-bit variants (`co64`, extended sizes) and malformed input
- Integration tests: real samples across the four source categories (iPhone / Mac / cameras / ProRes + legacy cameras), see ARCHITECTURE.md §7
- When fixing a domain bug (rotation, HDR, A/V sync, …), first add a reproducing sample or synthetic case, then fix
