# Local custody contract

The portable contract every implementation proves. Vectors live in
`vectors.json`; a port passes when each case produces the named outcome.

## Terms

- **Private directory**: a physical, canonical, owner-only directory.
- **Owned path**: a filesystem object whose metadata matches its expected
  kind, owner, mode, and link count exactly.
- **Control socket**: a newline-delimited JSON request/response endpoint on a
  Unix-domain socket inside a private directory.
- **Protected input**: a secret or handoff document read from an open
  descriptor — never argv, environment, or a terminal.

## Platform boundary

Unix implements the complete custody contract. Windows implements the bounded
path and read subset proven by native CI, without claiming transport or
publication parity:

- `assert_owned_path` and `stable_read` reject final-component reparse points
  and alternate data streams, bind identity to the volume serial number and
  file index obtained from an open handle, and enforce kind, link-count, size,
  and replacement checks.
- Windows `ownerOnly` means one protected, non-inherited DACL containing one
  full-control ACE for the current user SID, with that SID also owning the
  object. Every `exactMode` returns `unsupported`: Windows access masks do not
  reproduce Unix read, write, and execute bits exactly.
- `ensure_private_directory` creates the final directory with that descriptor
  in the creation call, rejects every reparse point in the existing ancestor
  chain, and revalidates owner, DACL, kind, and handle identity after creation.
- Windows `assert_owned_path` returns `unsupported` for `canonical`, and
  `stable_read` does so for `nonblocking`. Atomic publication, owned and
  protected descriptors, and control sockets remain `unsupported`.
- Native CI executes this subset on Windows, but no Windows sidecar artifact is
  published or activated downstream yet.

## Rules

### Private directory

1. Resolve the path; the parent must equal its own `realpath`.
2. Create missing directories with mode `0700`.
3. The result must be a directory, not a symbolic link, owned by the current
   uid, with `mode & 0o077 === 0`, and equal to its own `realpath`.
4. Owner checks apply where the platform exposes a uid; type, link, and mode
   checks apply everywhere.

### Owned path

1. `lstat` only — a symbolic link always fails.
2. Kind must match exactly: regular file, directory, or socket.
3. `uid` must equal the current uid when the platform exposes one.
4. When `exactMode` is given, `mode & 0o777` must equal it; when
   `ownerOnly` is given, `mode & 0o077` must equal zero.
5. Files and sockets default to exactly one hard link.
6. Optional size bounds are inclusive and compared in bytes.
7. When `canonical` is set, `realpath(path)` must equal `path` exactly — no
   component may resolve through a link.
8. Validation returns the object's `dev`/`ino` identity and observed size so
   callers can detect replacement across a time-of-check/time-of-use gap and
   build byte-bearing custody evidence.

### Owned descriptor

An already-open descriptor can be validated the same way with `fstat` —
the check for files whose bytes or metadata change constantly, where any
path re-resolution would race. Every owned-path rule applies except the
two that need a path: a descriptor can never be a symbolic link, and
`canonical` cannot be proven, so requesting `canonical` fails closed. The
descriptor is borrowed for the duration of the check — never closed, never
modified — and returns the same `dev`/`ino` identity.

### Stable read

1. `open` the path `O_RDONLY | O_NOFOLLOW` — a symbolic link can never be
   opened through this contract. Implementations may also accept a
   `nonblocking` request that adds `O_NONBLOCK` so a FIFO or other
   blocking-kind path fails fast instead of stalling the open; regular
   files are unaffected.
2. `fstat` the descriptor: it must be a regular file, owned by the current
   uid where one exists, within the byte bound, and with exactly one hard
   link unless `links` says otherwise.
3. Mode expectation defaults to owner-only (`mode & 0o077 === 0`);
   `exactMode` replaces it with an exact `mode & 0o777` equality and
   `minimumBytes` may demand a non-empty object.
4. Read exactly the observed size; an early EOF means the file shrank during
   the read — fail.
5. Re-`lstat` the path and require the same object: device, inode, link
   count, mode, owner, size, mtime, and ctime identical at nanosecond
   precision where the platform exposes it.
6. Return the bytes together with the read object's `dev`/`ino` identity so
   callers can build custody evidence bound to the exact bytes read.

### Atomic publication

1. The target name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$` and stay
   within 128 UTF-8 bytes.
2. Write to a unique same-directory temporary created `O_CREAT | O_EXCL |
   O_WRONLY | O_NOFOLLOW`, then `fchmod` `0600` so the staged mode is
   deterministic under any umask.
3. `fsync` the file, close it, run the caller's optional commit guard —
   a throwing guard aborts the publish — `rename` over the target, `fsync`
   the directory. The guard is the compare-and-swap seam: it observes the
   fully durable staged object (the Rust `atomic_publish_guarded` passes
   the staging path, the TypeScript `beforeCommit` receives the target
   path) and must not block indefinitely.
4. Re-validate the published name as an owned file: mode `0600`, one link.
5. On any failure, best-effort unlink the temporary; never leave it behind.
6. Create-once publication commits with `link(2)` instead of `rename`: the
   staged file is hard-linked to the target so an existing name fails the
   commit atomically with `EEXIST` — existence check and commit are one
   step, with no check-then-act window. The preserved object is validated
   (kind, owner, `0600` — not link count, which a racing winner's staging
   link can transiently raise) and reported `created: false`.
7. Where a filesystem has no hard links, create-once falls back to an
   atomic no-clobber rename — `renameat2(RENAME_NOREPLACE)` on Linux and
   Android, `renameatx_np(RENAME_EXCL)` on Apple platforms — and only to a
   documented check-then-rename where neither primitive exists; that last
   resort keeps the preserve-existing contract but not the race guarantee.

### Control socket

1. The socket path must stay within 100 UTF-8 bytes (below
   `sockaddr_un.sun_path`).
2. Before binding, a stale socket is removed only after it validates as an
   owned `0600` socket; anything else fails closed.
3. After `listen`, `chmod` `0600` and re-validate kind, owner, mode, and link
   count.
4. One connection carries at most `maximumRequestsPerConnection` complete
   newline-terminated frames (default 1). Each frame is fatal-decoded UTF-8,
   `JSON.parse`d to an unknown value, and handed to the product handler.
   Products serialize a bounded response followed by `\n`.
5. Failure envelopes are reason-coded — `capacity`, `limit`,
   `invalid-request`, or `response-limit` — and the product maps each reason
   to its wire body (one fixed value is allowed). Transport errors never
   expose internals.
6. Connection count, header deadline, and idle deadline are all bounded.
7. The transport layer attaches to a caller-created server so products that
   stage the bind (custody records, staged rename) keep their own lifecycle;
   transport close performs teardown only and never unlinks.
8. Closing the listener unlinks the socket only while it is still the exact
   `dev`/`ino` this listener published. Some runtimes also unlink the bound
   pathname unconditionally on close; implementations that can must apply
   the identity guard, and products that need successor detection must keep
   their own custody record.

### Control client

1. The socket's directory must validate as a canonical private directory
   before connecting; a client never creates it.
2. Record the socket's `dev`/`ino` before `connect` and re-`lstat` after
   `connect`; a changed identity means a replaced endpoint — abort.
3. One request frame per connection, bounded on write; the response is one
   complete line within the response bound and deadline. Trailing bytes fail.
4. The response reaches the product only through a narrowing parser from
   `unknown`.

### Protected input

1. Input comes from an open descriptor, never argv or the environment.
2. Terminals are refused.
3. A regular file must be uid-owned with `mode & 0o077 === 0`.
4. Reads stop at EOF or the byte bound; exceeding the bound fails.
5. Content is fatal-decoded UTF-8; the caller owns trimming and parsing.

### Sidecar

The Rust crate ships a `local-custody` binary that reproduces the contract
behind a newline-delimited JSON protocol on stdio.

1. One request per line on stdin; exactly one response line on stdout per
   request. The process exits on stdin EOF.
2. Requests are `{"op": <name>, ...}` with one of:
   `ensure_private_directory` `{path}` → `{path, dev, ino}`;
   `assert_owned_path` `{path, kind, exactMode, ownerOnly, maximumBytes,
   minimumBytes, links, canonical}` → `{dev, ino, size}`;
   `stable_read` `{path, exactMode, ownerOnly, maximumBytes, minimumBytes,
   links, nonblock}` → `{dev, ino, size, contentBase64}` — `nonblock: true`
   opens with `O_NONBLOCK` so a blocking-kind path fails fast;
   `atomic_publish` `{dir, name, contentBase64, createOnce}` →
   `{path, created}` where `created` is `false` only when `createOnce`
   preserved a pre-existing target;
   `read_protected_descriptor` `{fd, maximumBytes}` → `{content}`;
   `read_protected_stdin` `{maximumBytes}` → `{content}`;
   `control_socket_request` `{socketPath, request, maximumResponseBytes,
   timeoutMs}` → the socket's raw response value.
3. `exactMode` is an octal **string** (for example `"0600"`); byte bounds are
   unsigned integers; payloads are base64.
4. A domain failure is `{"ok":false,"code","message"}` — `code` names the
   check that failed and `message` is human-readable detail. An
   `{"ok":false,...}` body **without** `message` is not a sidecar failure:
   `control_socket_request` passes the socket's own failure envelope through
   untouched.
5. `invalid-request` covers unparseable lines, unknown ops, and malformed
   fields; the sidecar answers every line, never exits early on a bad one.
6. Every input stays bounded: request lines, response payloads, and read
   bounds come from the caller's declared limits; loaders add their own
   byte and deadline ceilings on top.
7. Library-only surfaces stay off the wire: `assert_owned_fd` needs an
   open descriptor in the caller's own table, and `atomic_publish_guarded`
   runs an in-process commit guard — neither crosses the process boundary,
   so there is no `assert_owned_fd` or guarded-publish op. Engines route
   `beforeCommit` publishes to the in-process implementation for the same
   reason.

### Execution flavor

Every filesystem rule applies identically in the asynchronous and the
`*Sync` synchronous forms. The synchronous forms exist for products whose
custody checks run inside genuinely synchronous setup paths; they change no
expectation, check, or outcome.
