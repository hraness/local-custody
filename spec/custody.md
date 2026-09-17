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
4. When `exactMode` is given, `mode & 0o777` must equal it.
5. Files and sockets default to exactly one hard link.
6. Optional size bounds are inclusive and compared in bytes.

### Atomic publication

1. The target name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$` and stay
   within 128 UTF-8 bytes.
2. Write to a unique same-directory temporary created `O_CREAT | O_EXCL |
   O_WRONLY | O_NOFOLLOW` with mode `0600`.
3. `fsync` the file, close it, `rename` over the target.
4. Re-validate the published name as an owned file: mode `0600`, one link.
5. On any failure, best-effort unlink the temporary; never leave it behind.

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
5. Oversize, empty, or surplus frames close the connection after a fixed
   product failure response. Handler exceptions produce the same failure
   response; transport errors never expose internals.
6. Connection count, header deadline, and idle deadline are all bounded.
7. Closing the listener unlinks the socket only if it still validates as an
   owned socket — never remove a successor's endpoint.

### Control client

1. The socket's directory must validate as private before connecting.
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
