# @hraness/local-custody

Owner-only local custody primitives for Hraness product CLIs.

Product CLIs keep authority — credentials, state, and mutations stay in
product code. This package supplies the *substrate* every CLI was
re-implementing: private-directory and owned-path validation, atomic private
file publication, a bounded newline-delimited JSON control socket, and
protected descriptor input.

## Entrypoints

| Subpath | Surface |
|---|---|
| `@hraness/local-custody` | Whole stable surface |
| `/private-paths` | `ensurePrivateDirectory`, `assertOwnedPath`, `assertOwnedPathSync`, `readPrivateFile`, `readOwnedFileStable`, `readOwnedFileStableSync` |
| `/atomic-publish` | `publishPrivateFile`, `createPrivateFileOnce`, `createPrivateFileOnceSync` |
| `/control-socket` | `listenControlSocket`, `attachControlSocket`, `requestControlSocket` |
| `/protected-input` | `readProtectedDescriptor`, `readProtectedStdin` |
| `/custody-rust` | `loadLocalCustodyRustEngine` — Rust-sidecar-preferred engine with TypeScript fallback |
| `/artifact-manifest` | `loadLocalCustodyArtifactManifest`, `findLocalCustodyArtifact` — shipped-artifact manifest reader |
| `/rust-fallback` | `emitLocalCustodyFallback` — bounded fallback diagnostics |

## Guarantees

- Every filesystem check uses `lstat` and fails on symbolic links.
- Owner checks apply where the platform exposes a uid; type, mode, link, and
  size checks apply everywhere.
- Socket paths stay under `sockaddr_un.sun_path`; endpoints are re-validated
  after bind and after connect (dev/ino identity).
- Frames are bounded, fatal-decoded UTF-8 JSON; transport errors never expose
  internals — products supply the fixed failure envelope.
- Secrets arrive only through open descriptors; terminals are refused.

The portable contract — including the corpus a port must reproduce — lives in
[`spec/custody.md`](spec/custody.md) and [`spec/vectors.json`](spec/vectors.json).
A Rust implementation passes when it produces every named outcome.

## Rust sidecar

The package ships a native `local-custody` sidecar binary (Linux x64, macOS
arm64 and x64) under `dist/rust-artifacts/`, with its digests recorded in
`dist/rust-artifacts/manifest.json`. The `/custody-rust` entrypoint loads it:

```ts
import { loadLocalCustodyRustEngine } from "@hraness/local-custody/custody-rust";

const engine = await loadLocalCustodyRustEngine();
engine.implementation; // "rust-sidecar" | "typescript"
```

Every delegatable operation runs through the sidecar's bounded JSON-lines
protocol; operations the Rust engine cannot reproduce faithfully — a
`beforeCommit` commit hook, directory assertions without a link bound,
non-regular or stdin protected descriptors, and the control-socket server
lifecycle — keep the TypeScript implementation with a bounded, sanitized
stderr notice. A missing or misbehaving binary falls back entirely; domain
failures report as `CustodyError` with the sidecar's failure `code`.

`HRANESS_LOCAL_CUSTODY_CLI_PATH` overrides the staged binary path (for
development or out-of-band sidecar delivery). Rebuild the host artifact with
`bun run rust:build:artifacts`; `bun run rust:build:manifest` regenerates the
manifest for staged targets.

### Rust crate

The `local-custody` crate in `rust/` is a standalone library implementation
of the same contract — owned-path and owned-descriptor (`fstat`) validation,
stable bounded reads (with an `O_NONBLOCK` open option), link-based
no-clobber create-once, and a commit-guarded atomic publish. A virtual
workspace at the repository root makes it consumable as a cargo git
dependency pinned to a reviewed commit:

```toml
local-custody = { git = "https://github.com/hraness/local-custody", rev = "<sha>" }
```

Native Windows CI covers handle identity, reparse and alternate-stream
rejection, hard-link counts, stable reads, current-user-only ACL validation,
private-directory creation, and the matching sidecar wire operations. Windows
atomic publication, descriptor custody, nonblocking opens, canonical path
equality, and control sockets remain unsupported. No Windows sidecar is
published or selected by the package yet.

Descriptor custody and the commit guard are process-local and intentionally
absent from the sidecar protocol — see `spec/custody.md`.

## Install

```sh
bun add github:hraness/local-custody#v0.1.0
```

## Development

Bun 1.3.14. `bun run check` is the required gate: portfolio inventory, lint,
typecheck, tests, deterministic build, and a packed-consumer smoke that runs a
live control-socket round trip under Node.

Releases are immutable `v*` tags; the release workflow re-runs the full gate
and publishes a checks-gated GitHub Release, then mirrors the same version to
npm through the tag-only `npm-release` environment and OIDC trusted publishing.
