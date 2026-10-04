# @hraness/local-custody

Keep a CLI's private files, local control socket, and secret input out of reach of other users on the same machine.

The package provides private directories and owner-only path checks, atomic
writes of private files, a newline-delimited JSON control socket with size and
time limits, and secrets read from an open file descriptor. Your CLI still owns
its credentials, state, and changes; the package checks where and how they are
stored and passed. Every check is supported on Unix. On Windows, the Rust crate
supports only the path, read, and private-directory checks, and the TypeScript
package skips owner checks (see [Windows](#windows)).

## Install

```sh
bun add @hraness/local-custody
```

The npm package includes a prebuilt Rust sidecar for Linux x64 and macOS arm64
and x64. The published TypeScript types support `erasableSyntaxOnly`.

## Create and read a private file

On Unix, save this as `private-file.ts` in your project and run
`bun private-file.ts`. Use a working directory whose parent paths are not
symbolic links. The sample stores non-sensitive text, not a credential.

```ts
import { join } from "node:path";
import {
  ensurePrivateDirectory,
  createPrivateFileOnce,
  readPrivateFile,
} from "@hraness/local-custody";

const directory = await ensurePrivateDirectory(join(process.cwd(), ".private-demo"));
const result = await createPrivateFileOnce(directory, "note.txt", "Sample note\n");
const bytes = await readPrivateFile(join(directory, "note.txt"), 1024);
console.log(result, bytes.byteLength);
```

The first run prints `created 12`. It creates a private directory and a
mode-0600 file. A second run prints `existing 12` if the sample file is unchanged;
`createPrivateFileOnce` never replaces that name. An `existing` result alone does
not validate the existing file, so keep the read check.

The parent directory must exist. If a path fails ownership, mode, or link
checks, inspect it before retrying; do not delete it or loosen permissions to
make the check pass. For intentional replacement, `publishPrivateFile` renames
new content over the target and accepts a `beforeCommit` check. These files are
not encrypted. See [Windows limits](#windows) before using this example there,
and [failure messages](#explain-failures-to-people) to report errors without
printing private paths or contents.

## Entrypoints

| Subpath | Exports |
|---|---|
| `@hraness/local-custody` | The file, socket, and protected-input exports below, plus `describeCustodyError` |
| `/private-paths` | `ensurePrivateDirectory`, `assertOwnedPath`, `assertOwnedPathSync`, `readPrivateFile`, `readOwnedFileStable`, `readOwnedFileStableSync` |
| `/atomic-publish` | `publishPrivateFile`, `createPrivateFileOnce`, `createPrivateFileOnceSync` |
| `/control-socket` | `listenControlSocket`, `attachControlSocket`, `requestControlSocket`, `ControlSocketError` |
| `/protected-input` | `readProtectedDescriptor`, `readProtectedStdin`, `ProtectedInputError` |
| `/custody-rust` | `loadLocalCustodyRustEngine`, which prefers the Rust sidecar and falls back to TypeScript; `readGenericPassword`, for macOS Keychain reads without a fallback |
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

## Explain failures to people

`describeCustodyError(error, { product, command, startCommand?, inputCommand?, inputExample?, during? })`
turns any failure from this package into one sentence and one next step, so a
product never prints an internal error:

```ts
import { describeCustodyError } from "@hraness/local-custody";

const { message, next } = describeCustodyError(error, {
  product: "Textbutler", command: "textbutler", startCommand: "textbutler daemon start",
});
// message: "Textbutler's background service isn't running."
// next:    "textbutler daemon start"
```

It recognizes `ControlSocketError` and `ProtectedInputError` codes, Rust and
sidecar error codes, and this package's fixed error messages. Rust uses
generic codes such as `read` and `not-found`, so pass `during: "control"` (or
`"input"`) to describe them as a stopped service rather than a file problem.
Anything else is described as unexpected with `{command} doctor` as the next
step. Paths and codes never appear in the text, and the copy never suggests
deleting files. For terminal input, pass `inputExample` (such as
`pbpaste | ghostget login --stdin`) to show an exact command.

A request to a socket that doesn't exist fails with
`ControlSocketError` code `control-unavailable` (the original `ENOENT` is its
`cause`), and reading protected input from a terminal says to pipe or redirect
the value in.

Each error class has one identity across entrypoints, so an
error thrown through `@hraness/local-custody/control-socket` passes
`instanceof` against the class imported from the package root.

The Rust crate has the same copy through
`describe_error(code, &DescribeOptions { .. })` and `CustodyError::describe`;
`bun run generate:error-copy` writes `rust/src/error-copy.json` from the
TypeScript table and the check fails if they drift.

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
The engine uses TypeScript when the sidecar cannot load or an operation has a
transport or protocol failure, and prints a short, sanitized notice on stderr.
Domain failures surface as `CustodyError` with the sidecar's failure `code`;
domain errors and invalid input do not trigger a fallback. The separate
`readGenericPassword` function has no TypeScript fallback.

`HRANESS_LOCAL_CUSTODY_CLI_PATH` overrides the staged binary path (for
development or a sidecar delivered separately). Rebuild the host artifact with
`bun run rust:build:artifacts`; `bun run rust:build:manifest` regenerates the
manifest for staged targets.

### Read a macOS Keychain item

`readGenericPassword(binaryPath, service, account)` reads one generic-password
item through a product-selected signed helper. The sidecar's
`generic_password_read` operation uses `SecItemCopyMatching`, so the Keychain
request is attributed to that helper's signing identity. macOS controls access
and any permission prompt.

Both selectors must be 1–256 UTF-8 bytes without control characters. The read
returns a `Uint8Array` of at most 4096 bytes. Failure codes include `missing`, `denied`,
`interaction-not-allowed`, `keychain-error`, `limit`, and `unsupported` off
macOS. There is no TypeScript fallback because it would change which binary
requests access. See the [protocol reference](spec/custody.md#generic-password-read).

### Rust crate

The `local-custody` crate in `rust/` is a standalone library that implements
the same rules: owned-path and owned-descriptor (`fstat`) checks, stable
size-limited reads (with an `O_NONBLOCK` open option), create-once writes
that commit with a hard link so an existing file is never replaced, and
atomic publish with a commit guard. A virtual workspace at the repository
root lets you use it as a Cargo git dependency pinned to a reviewed commit:

```toml
local-custody = { git = "https://github.com/hraness/local-custody", rev = "<sha>" }
```

Descriptor checks and the commit guard work within one process, so the
sidecar protocol does not include them. See `spec/custody.md`.

The crate's `read_protected_descriptor` accepts pipes and sockets, so
`pbpaste | <cli> login --stdin` works in Rust CLIs. A regular file must be owned
by you and private; other descriptor kinds are refused.

### Windows

Native Windows CI covers handle identity, reparse and alternate-stream
rejection, hard-link counts, stable reads, current-user-only ACL validation,
private-directory creation, and the matching sidecar wire operations. Windows
atomic publication, descriptor checks, nonblocking opens, canonical path
equality, and control sockets are unsupported. The package does not publish
or select a Windows sidecar.

## Compared with other tools

[write-file-atomic](https://github.com/npm/write-file-atomic) replaces a file
atomically and can set its owner and mode, but it does not reject a file with
the wrong owner or refuse a symbolic link. An OS keychain, for example through
[@napi-rs/keyring](https://github.com/Brooooooklyn/keyring-node), encrypts
secrets at rest. Choose a keychain when that matters, because this package keeps
files private through ownership and mode, without encryption. On macOS the
Rust sidecar can read an existing keychain item through
`generic_password_read`, but the package does not store secrets in a keychain.
local-custody also covers the local control socket and descriptor-only secret
input. Checked on 2026-09-28.

## Development

Bun 1.3.14. `bun run check` is the required check: portfolio inventory, lint,
typecheck, tests, deterministic build, and a packed-consumer smoke that runs a
live control-socket round trip under Node.

Releases are immutable `v*` tags. The release workflow reruns the full check,
publishes a GitHub Release, and then publishes the same version to npm through
the tag-only `npm-release` environment and OIDC trusted publishing.
Merging a `package.json` version bump to `main` creates its annotated `v*` tag
automatically once CI passes on that commit; pushing the tag by hand still
works.

## License

MIT. Maintained by [Hraness](https://hraness.com).
