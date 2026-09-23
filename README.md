# @hraness/local-custody

Keep a CLI's private files, local control socket, and secret input out of reach of other users on the same machine.

Each Hraness product CLI used to write its own version of these checks. This
package provides them once: private directories and owner-only path checks,
atomic writes of private files, a newline-delimited JSON control socket with
size and time limits, and secrets read from an open file descriptor. Your CLI
still owns its credentials, state, and changes; the package checks where and
how they are stored and passed. Unix systems get every check. Windows gets the
path, read, and private-directory checks only (see [Windows](#windows)).

## Install

```sh
bun add @hraness/local-custody
```

The npm package includes a prebuilt Rust sidecar for Linux x64 and macOS arm64
and x64.

## Entrypoints

| Subpath | Exports |
|---|---|
| `@hraness/local-custody` | Every stable export below |
| `/private-paths` | `ensurePrivateDirectory`, `assertOwnedPath`, `assertOwnedPathSync`, `readPrivateFile`, `readOwnedFileStable`, `readOwnedFileStableSync` |
| `/atomic-publish` | `publishPrivateFile`, `createPrivateFileOnce`, `createPrivateFileOnceSync` |
| `/control-socket` | `listenControlSocket`, `attachControlSocket`, `requestControlSocket` |
| `/protected-input` | `readProtectedDescriptor`, `readProtectedStdin` |
| `/custody-rust` | `loadLocalCustodyRustEngine`, which prefers the Rust sidecar and falls back to TypeScript |
| `/artifact-manifest` | `loadLocalCustodyArtifactManifest`, `findLocalCustodyArtifact`, which read the manifest of shipped sidecar binaries |
| `/rust-fallback` | `emitLocalCustodyFallback`, which prints a short notice when an operation falls back to TypeScript |

## Guarantees

- Every filesystem check uses `lstat` and fails on symbolic links.
- Owner checks apply where the platform exposes a uid; type, mode, link, and
  size checks apply everywhere.
- Socket paths fit in `sockaddr_un.sun_path`, and the package checks the
  endpoint's device and inode again after bind and after connect.
- Frames are size-limited UTF-8 JSON, and invalid UTF-8 is rejected rather
  than replaced. Transport errors never include internal details; your product
  supplies the error response it sends.
- Secrets arrive only through open descriptors; terminals are refused.

The rules every implementation follows are in [`spec/custody.md`](spec/custody.md),
and the cases a port must reproduce are in [`spec/vectors.json`](spec/vectors.json).
A Rust implementation passes when it produces the named outcome for every case.

## Rust sidecar

The package ships a native `local-custody` sidecar binary (Linux x64, macOS
arm64 and x64) under `dist/rust-artifacts/`, with its digests recorded in
`dist/rust-artifacts/manifest.json`. The `/custody-rust` entrypoint loads it:

```ts
import { loadLocalCustodyRustEngine } from "@hraness/local-custody/custody-rust";

const engine = await loadLocalCustodyRustEngine();
engine.implementation; // "rust-sidecar" | "typescript"
```

Operations the sidecar supports run through its JSON-lines protocol. These
stay in TypeScript because the Rust engine cannot reproduce them exactly: a
`beforeCommit` hook, directory checks without a link limit, protected input
from stdin or a non-regular file, and the control-socket server lifecycle.
When that happens, the package prints a short, sanitized notice on stderr. If
the binary is missing or misbehaves, every operation falls back to TypeScript.
Domain failures surface as `CustodyError` with the sidecar's failure `code`.

`HRANESS_LOCAL_CUSTODY_CLI_PATH` overrides the staged binary path (for
development or a sidecar delivered separately). Rebuild the host artifact with
`bun run rust:build:artifacts`; `bun run rust:build:manifest` regenerates the
manifest for staged targets.

### Rust crate

The `local-custody` crate in `rust/` is a standalone library that implements
the same rules: owned-path and owned-descriptor (`fstat`) checks, stable
size-limited reads (with an `O_NONBLOCK` open option), create-once writes
that commit with a hard link so an existing file is never replaced, and
atomic publish with a commit guard. A
virtual workspace at the repository root lets you use it as a Cargo git
dependency pinned to a reviewed commit:

```toml
local-custody = { git = "https://github.com/hraness/local-custody", rev = "<sha>" }
```

### Windows

Native Windows CI covers handle identity, reparse and alternate-stream
rejection, hard-link counts, stable reads, current-user-only ACL validation,
private-directory creation, and the matching sidecar wire operations. Windows
atomic publication, descriptor checks, nonblocking opens, canonical path
equality, and control sockets are unsupported. The package does not publish
or select a Windows sidecar.

Descriptor checks and the commit guard work within one process, so the
sidecar protocol does not include them. See `spec/custody.md`.

## Development

Bun 1.3.14. `bun run check` is the required check: portfolio inventory, lint,
typecheck, tests, deterministic build, and a packed-consumer smoke that runs a
live control-socket round trip under Node.

Releases are immutable `v*` tags. The release workflow reruns the full check,
publishes a GitHub Release, and then publishes the same version to npm through
the tag-only `npm-release` environment and OIDC trusted publishing.
