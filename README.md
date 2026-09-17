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
| `/private-paths` | `ensurePrivateDirectory`, `assertOwnedPath`, `readPrivateFile` |
| `/atomic-publish` | `publishPrivateFile` |
| `/control-socket` | `listenControlSocket`, `requestControlSocket` |
| `/protected-input` | `readProtectedDescriptor`, `readProtectedStdin` |

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

## Install

```sh
bun add github:hraness/local-custody#v0.1.0
```

## Development

Bun 1.3.14. `bun run check` is the required gate: portfolio inventory, lint,
typecheck, tests, deterministic build, and a packed-consumer smoke that runs a
live control-socket round trip under Node.

Releases are immutable `v*` tags; the release workflow re-runs the full gate
and publishes a checks-gated GitHub Release.
