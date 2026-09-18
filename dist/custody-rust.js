// src/private-paths.ts
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync
} from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var ownerUid = () => typeof process.getuid === "function" ? process.getuid() : undefined;
var kindMatches = (metadata, kind) => kind === "file" ? metadata.isFile() : kind === "directory" ? metadata.isDirectory() : metadata.isSocket();
async function assertOwnedPath(path, expectation) {
  const metadata = await lstat(path, { bigint: true });
  const uid = ownerUid();
  const expectedLinks = expectation.links ?? (expectation.kind === "directory" ? undefined : 1n);
  if (!kindMatches(metadata, expectation.kind) || metadata.isSymbolicLink() || expectedLinks !== undefined && metadata.nlink !== BigInt(expectedLinks) || uid !== undefined && metadata.uid !== BigInt(uid) || expectation.exactMode !== undefined && (metadata.mode & 0o777n) !== BigInt(expectation.exactMode) || expectation.ownerOnly === true && (metadata.mode & 0o077n) !== 0n || expectation.canonical === true && await realpath(path) !== path || expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes || expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
  return {
    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    size: Number(metadata.size)
  };
}
function assertOwnedPathSync(path, expectation) {
  const metadata = lstatSync(path, { bigint: true });
  const uid = ownerUid();
  const expectedLinks = expectation.links ?? (expectation.kind === "directory" ? undefined : 1n);
  if (!kindMatches(metadata, expectation.kind) || metadata.isSymbolicLink() || expectedLinks !== undefined && metadata.nlink !== BigInt(expectedLinks) || uid !== undefined && metadata.uid !== BigInt(uid) || expectation.exactMode !== undefined && (metadata.mode & 0o777n) !== BigInt(expectation.exactMode) || expectation.ownerOnly === true && (metadata.mode & 0o077n) !== 0n || expectation.canonical === true && realpathSync(path) !== path || expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes || expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
  return {
    dev: Number(metadata.dev),
    ino: Number(metadata.ino),
    size: Number(metadata.size)
  };
}
async function ensurePrivateDirectory(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (await realpath(parent) !== parent) {
    throw new Error("Directory parent must be physical.");
  }
  try {
    await mkdir(absolute, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
  const metadata = await lstat(absolute);
  if (await realpath(absolute) !== absolute || !metadata.isDirectory() || metadata.isSymbolicLink() || ownerUid() !== undefined && metadata.uid !== ownerUid() || (metadata.mode & 63) !== 0) {
    throw new Error("Directory must be physical, owned, and private.");
  }
  return absolute;
}
var checkStableCandidate = (before, maximumBytes, expectation) => {
  const uid = ownerUid();
  const links = BigInt(expectation.links ?? 1);
  if (!before.isFile() || before.nlink !== links || uid !== undefined && before.uid !== BigInt(uid) || (expectation.exactMode !== undefined ? (before.mode & 0o777n) !== BigInt(expectation.exactMode) : expectation.ownerOnly !== false && (before.mode & 0o077n) !== 0n) || expectation.minimumBytes !== undefined && before.size < expectation.minimumBytes || before.size > BigInt(maximumBytes)) {
    throw new Error("Unsafe private file.");
  }
};
var checkStableResult = (before, after) => {
  if (after.isSymbolicLink() || !after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== before.nlink || after.mode !== before.mode || after.uid !== before.uid || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
    throw new Error("Private file changed during the read.");
  }
};
async function readOwnedFileStable(path, maximumBytes, expectation = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    checkStableCandidate(before, maximumBytes, expectation);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0)
        break;
      offset += bytesRead;
    }
    const after = await lstat(path, { bigint: true });
    checkStableResult(before, after);
    if (offset !== buffer.byteLength) {
      throw new Error("Private file changed during the read.");
    }
    return { bytes: buffer, dev: Number(before.dev), ino: Number(before.ino) };
  } finally {
    await handle.close();
  }
}
function readOwnedFileStableSync(path, maximumBytes, expectation = {}) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    checkStableCandidate(before, maximumBytes, expectation);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (count === 0)
        break;
      offset += count;
    }
    const after = lstatSync(path, { bigint: true });
    checkStableResult(before, after);
    if (offset !== buffer.byteLength) {
      throw new Error("Private file changed during the read.");
    }
    return { bytes: buffer, dev: Number(before.dev), ino: Number(before.ino) };
  } finally {
    closeSync(descriptor);
  }
}
async function readPrivateFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    const uid = ownerUid();
    if (!metadata.isFile() || metadata.nlink !== 1 || uid !== undefined && metadata.uid !== uid || (metadata.mode & 63) !== 0 || metadata.size > maximumBytes) {
      throw new Error("Unsafe private file.");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes)
      throw new Error("Private file exceeds its size bound.");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// src/atomic-publish.ts
import { randomUUID } from "node:crypto";
import {
  closeSync as closeSync2,
  constants as constants2,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync as openSync2,
  unlinkSync,
  writeSync
} from "node:fs";
import { link, open as open2, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
var safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;
var assertSafeName = (name) => {
  if (!safeFileName.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
};
var syncDirectory = async (directory) => {
  const handle = await open2(directory, constants2.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
var writeStaged = async (staged, content) => {
  const handle = await open2(staged, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
async function publishPrivateFile(directory, name, content, options = {}) {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeStaged(temporary, content);
    await options.beforeCommit?.(target);
    await rename(temporary, target);
    await syncDirectory(directory);
    await assertOwnedPath(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 1
    });
  } catch (error) {
    await unlink(temporary).catch(() => {
      return;
    });
    throw error;
  }
}
async function createPrivateFileOnce(directory, name, content) {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeStaged(temporary, content);
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code === "EEXIST")
        return "existing";
      throw error;
    }
    await syncDirectory(directory);
    await assertOwnedPath(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 2
    });
    return "created";
  } finally {
    await unlink(temporary).catch(() => {
      return;
    });
    await syncDirectory(directory).catch(() => {
      return;
    });
  }
}
var writeStagedSync = (staged, content) => {
  const descriptor = openSync2(staged, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync2(descriptor);
  }
};
var syncDirectorySync = (directory) => {
  const descriptor = openSync2(directory, constants2.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync2(descriptor);
  }
};
function createPrivateFileOnceSync(directory, name, content) {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    writeStagedSync(temporary, content);
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (error.code === "EEXIST")
        return "existing";
      throw error;
    }
    syncDirectorySync(directory);
    assertOwnedPathSync(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 2
    });
    return "created";
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
    try {
      syncDirectorySync(directory);
    } catch {}
  }
}

// src/control-socket.ts
import { chmod, unlink as unlink2 } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { dirname as dirname2 } from "node:path";
var MAXIMUM_SOCKET_PATH_BYTES = 100;
var DEFAULT_MAXIMUM_CONNECTIONS = 16;
var DEFAULT_HEADER_TIMEOUT_MS = 5000;
var DEFAULT_IDLE_TIMEOUT_MS = 1e4;
var MAXIMUM_TIMEOUT_MS = 3600000;
var boundedTimeoutMs = (value, fallback) => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAXIMUM_TIMEOUT_MS) {
    throw new Error("Control socket timeouts must be positive integers within one hour.");
  }
  return candidate;
};
var boundedCount = (value, fallback, maximum) => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error("Control socket bounds must be positive integers.");
  }
  return candidate;
};
var socketIdentity = (path) => assertOwnedPath(path, { kind: "socket", exactMode: PRIVATE_FILE_MODE, links: 1 });
var sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
var resolveBounds = (options) => {
  const maximumFrameBytes = options.maximumFrameBytes;
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
    throw new Error("Control frame bound must be a positive integer.");
  }
  return {
    maximumFrameBytes,
    maximumResponseBytes: options.maximumResponseBytes ?? maximumFrameBytes,
    maximumConnections: boundedCount(options.maximumConnections, DEFAULT_MAXIMUM_CONNECTIONS, 1024),
    maximumRequests: boundedCount(options.maximumRequestsPerConnection, 1, 1024),
    headerTimeoutMs: boundedTimeoutMs(options.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS),
    idleTimeoutMs: boundedTimeoutMs(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS)
  };
};
function attachControlSocket(server, options) {
  const bounds = resolveBounds(options);
  const failure = options.failureResponse;
  const encode = (value, reason) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}
`);
    if (bytes.length <= bounds.maximumResponseBytes)
      return bytes;
    const fallback = Buffer.from(`${JSON.stringify(failure(reason))}
`);
    if (fallback.length <= bounds.maximumResponseBytes)
      return fallback;
    return Buffer.alloc(0);
  };
  const clients = new Set;
  const work = new Set;
  let closing = false;
  server.on("connection", (socket) => {
    if (closing || clients.size >= bounds.maximumConnections) {
      const bytes = encode(failure("capacity"), "capacity");
      if (bytes.length === 0)
        socket.destroy();
      else
        socket.end(bytes);
      return;
    }
    clients.add(socket);
    let idleTimer;
    socket.once("close", () => {
      clients.delete(socket);
      if (idleTimer !== undefined)
        clearTimeout(idleTimer);
    });
    socket.on("error", () => {
      return;
    });
    const controller = new AbortController;
    let received = Buffer.alloc(0);
    let requests = 0;
    let chain = Promise.resolve();
    const headerTimer = setTimeout(() => socket.destroy(), bounds.headerTimeoutMs);
    headerTimer.unref();
    const armIdle = () => {
      if (idleTimer !== undefined)
        clearTimeout(idleTimer);
      if (requests >= bounds.maximumRequests)
        return;
      idleTimer = setTimeout(() => socket.destroy(), bounds.idleTimeoutMs);
      idleTimer.unref();
    };
    socket.on("data", (chunk) => {
      if (closing) {
        socket.destroy();
        return;
      }
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (true) {
        const newline = received.indexOf(10);
        if (newline < 0) {
          if (received.byteLength >= bounds.maximumFrameBytes)
            socket.destroy();
          return;
        }
        if (newline === 0 || newline + 1 > bounds.maximumFrameBytes || requests >= bounds.maximumRequests) {
          const bytes = encode(failure("limit"), "limit");
          if (bytes.length === 0)
            socket.destroy();
          else
            socket.end(bytes);
          return;
        }
        const frame = received.subarray(0, newline);
        received = received.subarray(newline + 1);
        requests += 1;
        clearTimeout(headerTimer);
        const task = chain.catch(() => {
          return;
        }).then(async () => {
          if (closing || socket.destroyed)
            return;
          let response;
          try {
            const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
            response = await options.onRequest(value, { signal: controller.signal });
          } catch {
            response = failure("invalid-request");
          }
          if (!socket.destroyed && !socket.writableEnded) {
            const bytes = encode(response, "response-limit");
            if (bytes.length === 0 || socket.writableLength + bytes.length > bounds.maximumResponseBytes) {
              socket.destroy();
            } else {
              socket.write(bytes, () => {
                if (requests >= bounds.maximumRequests)
                  socket.end();
                else
                  armIdle();
              });
            }
          }
        }).finally(() => work.delete(task));
        work.add(task);
        chain = task;
      }
    });
    socket.on("end", () => {
      if (received.byteLength !== 0)
        socket.destroy();
    });
  });
  let closePromise;
  return {
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const client of clients)
          client.destroy();
        await new Promise((resolve2, reject) => server.close((error) => error !== undefined && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve2()));
        await Promise.allSettled([...work]);
      })();
      return closePromise;
    }
  };
}
async function listenControlSocket(options) {
  const socketPath = options.socketPath;
  if (Buffer.byteLength(socketPath) > MAXIMUM_SOCKET_PATH_BYTES) {
    throw new Error("Control socket path exceeds its platform limit.");
  }
  await ensurePrivateDirectory(dirname2(socketPath));
  try {
    await socketIdentity(socketPath);
    await unlink2(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }
  const server = createServer();
  const transport = attachControlSocket(server, options);
  let published;
  try {
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve2();
      });
    });
    await chmod(socketPath, PRIVATE_FILE_MODE);
    published = await socketIdentity(socketPath);
  } catch (error) {
    await transport.close().catch(() => {
      return;
    });
    throw error;
  }
  return {
    socketPath,
    async close() {
      const failures = [];
      try {
        await transport.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        const current = await socketIdentity(socketPath).catch(() => null);
        if (current !== null && sameIdentity(current, published)) {
          await unlink2(socketPath);
        }
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) {
        throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Control socket cleanup requires attention.");
      }
    }
  };
}
async function requestControlSocket(options) {
  const { socketPath, maximumResponseBytes, timeoutMs } = options;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new Error("Control response bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error("Control request timeout must be a positive integer within one hour.");
  }
  const maximumRequestBytes = options.maximumRequestBytes ?? maximumResponseBytes;
  const frame = Buffer.from(`${JSON.stringify(options.request)}
`);
  if (frame.length > maximumRequestBytes) {
    throw new Error("Control request exceeds its frame limit.");
  }
  await assertOwnedPath(dirname2(socketPath), { kind: "directory", canonical: true });
  const before = await socketIdentity(socketPath);
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const settle = (error, value) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null)
        rejectPromise(error);
      else
        resolvePromise(value);
    };
    const timer = setTimeout(() => settle(new Error("Control request timed out.")), timeoutMs);
    socket.once("connect", () => {
      socketIdentity(socketPath).then((after) => {
        if (!sameIdentity(before, after))
          throw new Error("Control socket identity changed.");
        if (!settled)
          socket.write(frame);
      }).catch((error) => settle(error instanceof Error ? error : new Error("Control socket changed.")));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > maximumResponseBytes) {
        settle(new Error("Control response exceeds its frame limit."));
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0)
        return;
      if (newline !== buffer.length - 1) {
        settle(new Error("Unexpected additional control output."));
        return;
      }
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)));
        settle(null, options.parseResponse(value));
      } catch {
        settle(new Error("Invalid control response."));
      }
    });
    socket.once("error", () => settle(new Error("The control socket is unavailable.")));
    socket.once("close", () => {
      if (!settled)
        settle(new Error("The control socket closed without a response."));
    });
  });
}

// src/protected-input.ts
import { fstatSync as fstatSync2, readSync as readSync2 } from "node:fs";
import { isatty } from "node:tty";
var DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES = 65536;
function readProtectedDescriptor(descriptor, options = {}) {
  const maximumBytes = options.maximumBytes ?? DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Protected input bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("Protected input requires a valid descriptor.");
  }
  if (isatty(descriptor)) {
    throw new Error("Protected input does not read terminals.");
  }
  const metadata = fstatSync2(descriptor, { bigint: true });
  if (metadata.isFile()) {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && metadata.uid !== BigInt(uid) || (metadata.mode & 0o077n) !== 0n) {
      throw new Error("Protected input file must be owned and private.");
    }
  }
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (true) {
    const read = readSync2(descriptor, buffer, offset, buffer.length - offset, null);
    if (read === 0)
      break;
    offset += read;
    if (offset > maximumBytes)
      throw new Error("Protected input exceeds its size bound.");
    if (offset === buffer.length)
      throw new Error("Protected input exceeds its size bound.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
}
function readProtectedStdin(options = {}) {
  return readProtectedDescriptor(0, options);
}

// src/rust-fallback.ts
var MAX_FALLBACK_TAGS = 32;
var MAX_FALLBACK_NOTICES_PER_TAG = 4;
var DIAGNOSTIC_FIELD = /^[A-Za-z0-9._-]{1,64}$/u;
var emittedNotices = new Map;
function boundedField(value) {
  return DIAGNOSTIC_FIELD.test(value) ? value : "other";
}
function emitLocalCustodyFallback(notice) {
  const tag = boundedField(notice.tag);
  const reason = boundedField(notice.reason);
  const inputClass = notice.inputClass === undefined ? undefined : boundedField(notice.inputClass);
  const diagnostic = inputClass === undefined ? reason : `${reason}:${inputClass}`;
  let seen = emittedNotices.get(tag);
  if (seen === undefined) {
    if (emittedNotices.size >= MAX_FALLBACK_TAGS)
      return;
    seen = new Set;
    emittedNotices.set(tag, seen);
  }
  if (seen.has(diagnostic) || seen.size >= MAX_FALLBACK_NOTICES_PER_TAG)
    return;
  seen.add(diagnostic);
  try {
    if (typeof process !== "undefined" && typeof process.stderr?.write === "function") {
      const detail = inputClass === undefined ? reason : `${reason} input=${inputClass}`;
      process.stderr.write(`[${tag}] ${detail}
`);
    }
  } catch {}
}

// src/custody-rust.ts
import { spawn } from "node:child_process";
import { fstatSync as fstatSync3 } from "node:fs";
import { lstat as lstat2, realpath as realpath2, stat } from "node:fs/promises";
import { dirname as dirname3, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
var SPAWN_TIMEOUT_MS = 120000;
var ENVELOPE_SLACK_BYTES = 16 * 1024;
var FIXED_REQUEST_BYTES = 16 * 1024;
var FIXED_RESPONSE_BYTES = 64 * 1024;
var FALLBACK_TAG = "local-custody-rust-fallback";
var MAXIMUM_CONTROL_TIMEOUT_MS = 3600000;
var publishNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;

class CustodySidecarNotFoundError extends Error {
  platform;
  arch;
  binaryPath;
  name;
  constructor(platform, arch, binaryPath) {
    super(`local-custody sidecar not found for ${platform}-${arch} at ${binaryPath}`);
    this.platform = platform;
    this.arch = arch;
    this.binaryPath = binaryPath;
    this.name = "CustodySidecarNotFoundError";
  }
}

class CustodySidecarTimeoutError extends Error {
  timeoutMs;
  name;
  constructor(timeoutMs) {
    super(`local-custody sidecar did not respond within ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
    this.name = "CustodySidecarTimeoutError";
  }
}

class CustodySidecarProtocolError extends Error {
  reason;
  stdout;
  name;
  constructor(reason, stdout) {
    super(`local-custody sidecar produced unparseable output: ${String(reason)}`);
    this.reason = reason;
    this.stdout = stdout;
    this.name = "CustodySidecarProtocolError";
  }
}

class CustodyError extends Error {
  code;
  details;
  name;
  constructor(code, details) {
    super(`local-custody sidecar op failed: ${code}`);
    this.code = code;
    this.details = details;
    this.name = "CustodyError";
  }
}
function currentPlatformArch() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64")
    return { platform: "darwin", arch: "arm64" };
  if (platform === "darwin" && arch === "x64")
    return { platform: "darwin", arch: "x64" };
  if (platform === "linux" && arch === "x64")
    return { platform: "linux", arch: "x64" };
  throw new Error(`Unsupported platform for local-custody sidecar: ${platform}-${arch}`);
}
function artifactBaseDirectory() {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = dirname3(modulePath);
  const base = moduleDir.endsWith("/src") || moduleDir.endsWith("\\src") ? resolve2(moduleDir, "..", "dist") : moduleDir;
  return resolve2(base, "rust-artifacts", "local-custody");
}
function sidecarBinaryPath(platform = currentPlatformArch().platform, arch = currentPlatformArch().arch) {
  const override = process.env.HRANESS_LOCAL_CUSTODY_CLI_PATH;
  if (override !== undefined && override.length > 0)
    return resolve2(override);
  return resolve2(artifactBaseDirectory(), `${platform}-${arch}`, "local-custody");
}
async function runSidecar(binaryPath, requestJson, maximumResponseBytes, sharedDescriptor) {
  const stdio = sharedDescriptor === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", sharedDescriptor];
  const child = spawn(binaryPath, [], { stdio });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill("SIGKILL");
    throw new CustodySidecarProtocolError(new Error("sidecar stdio was not piped"), "");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (error === null)
        resolvePromise(value ?? "");
      else
        rejectPromise(error);
    };
    const failProtocol = (reason) => {
      child.kill("SIGKILL");
      finish(new CustodySidecarProtocolError(reason, Buffer.concat(chunks).toString("utf8")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CustodySidecarTimeoutError(SPAWN_TIMEOUT_MS));
    }, SPAWN_TIMEOUT_MS);
    child.once("error", (error) => finish(error));
    stdin.once("error", (error) => finish(error));
    stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumResponseBytes) {
        failProtocol(new Error("response exceeds maximum length"));
        return;
      }
      chunks.push(chunk);
    });
    stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > ENVELOPE_SLACK_BYTES)
        failProtocol(new Error("stderr exceeds maximum length"));
    });
    child.once("close", (code, signal) => {
      if (settled)
        return;
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 || signal !== null) {
        finish(new CustodySidecarProtocolError(new Error(`local-custody sidecar exited with code ${code ?? "unknown"}`), output));
        return;
      }
      const newline = output.indexOf(`
`);
      if (newline < 0 || output.slice(newline + 1).trim().length !== 0) {
        finish(new CustodySidecarProtocolError(new Error("response must be exactly one JSON line"), output));
        return;
      }
      finish(null, output.slice(0, newline));
    });
    stdin.end(`${requestJson}
`);
  });
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSafeCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sidecarFailure(parsed) {
  if (isRecord(parsed) && parsed.ok === false && typeof parsed.message === "string") {
    return new CustodyError(typeof parsed.code === "string" ? parsed.code : "unknown", parsed);
  }
  return null;
}
function parseSidecarResponse(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new CustodySidecarProtocolError(error, stdout);
  }
}
async function runRequest(binaryPath, request, maximumRequestBytes, maximumResponseBytes, sharedDescriptor) {
  const requestJson = JSON.stringify(request);
  if (Buffer.byteLength(requestJson, "utf8") > maximumRequestBytes) {
    throw new TypeError("custody sidecar request exceeds maximum length");
  }
  const stdout = await runSidecar(binaryPath, requestJson, maximumResponseBytes, sharedDescriptor);
  const parsed = parseSidecarResponse(stdout);
  const failure = sidecarFailure(parsed);
  if (failure !== null)
    throw failure;
  return parsed;
}
function octalMode(exactMode) {
  if (!Number.isSafeInteger(exactMode) || exactMode < 0 || exactMode > 4095) {
    throw new TypeError("exactMode must be a non-negative safe integer within mode bits");
  }
  return exactMode.toString(8).padStart(4, "0");
}
function boundedU64(value, label) {
  if (value === undefined)
    return;
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return converted;
}
function base64Bound(contentBytes) {
  return Math.ceil(contentBytes * 4 / 3) + 8;
}
var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
async function rustEnsurePrivateDirectory(binary, path) {
  const absolute = resolve2(path);
  const parsed = await runRequest(binary, { op: "ensure_private_directory", path: absolute }, FIXED_REQUEST_BYTES, FIXED_RESPONSE_BYTES);
  const candidate = parsed;
  if (!isRecord(parsed) || candidate.path !== absolute || !isSafeCount(candidate.dev) || !isSafeCount(candidate.ino)) {
    throw new CustodySidecarProtocolError(new Error("invalid ensure_private_directory fields"), JSON.stringify(parsed));
  }
  return candidate.path;
}
async function rustAssertOwnedPath(binary, path, expectation) {
  const request = { op: "assert_owned_path", path, kind: expectation.kind };
  if (expectation.exactMode !== undefined)
    request.exactMode = octalMode(expectation.exactMode);
  if (expectation.ownerOnly !== undefined)
    request.ownerOnly = expectation.ownerOnly;
  if (expectation.links !== undefined)
    request.links = boundedU64(expectation.links, "links");
  if (expectation.canonical !== undefined)
    request.canonical = expectation.canonical;
  const minimumBytes = boundedU64(expectation.minimumBytes, "minimumBytes");
  const maximumBytes = boundedU64(expectation.maximumBytes, "maximumBytes");
  if (minimumBytes !== undefined)
    request.minimumBytes = minimumBytes;
  if (maximumBytes !== undefined)
    request.maximumBytes = maximumBytes;
  const parsed = await runRequest(binary, request, FIXED_REQUEST_BYTES, FIXED_RESPONSE_BYTES);
  const candidate = parsed;
  if (!isRecord(parsed) || !isSafeCount(candidate.dev) || !isSafeCount(candidate.ino) || !isSafeCount(candidate.size)) {
    throw new CustodySidecarProtocolError(new Error("invalid assert_owned_path fields"), JSON.stringify(parsed));
  }
  return Object.freeze({ dev: candidate.dev, ino: candidate.ino, size: candidate.size });
}
async function rustReadOwnedFileStable(binary, path, maximumBytes, expectation) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("maximumBytes must be a non-negative safe integer");
  }
  const request = {
    op: "stable_read",
    path,
    maximumBytes
  };
  if (expectation.exactMode !== undefined)
    request.exactMode = octalMode(expectation.exactMode);
  if (expectation.ownerOnly !== undefined)
    request.ownerOnly = expectation.ownerOnly;
  if (expectation.links !== undefined)
    request.links = boundedU64(expectation.links, "links");
  const minimumBytes = boundedU64(expectation.minimumBytes, "minimumBytes");
  if (minimumBytes !== undefined)
    request.minimumBytes = minimumBytes;
  const parsed = await runRequest(binary, request, FIXED_REQUEST_BYTES, base64Bound(maximumBytes) + ENVELOPE_SLACK_BYTES);
  const candidate = parsed;
  if (!isRecord(parsed) || !isSafeCount(candidate.dev) || !isSafeCount(candidate.ino) || !isSafeCount(candidate.size) || typeof candidate.contentBase64 !== "string" || !BASE64_PATTERN.test(candidate.contentBase64)) {
    throw new CustodySidecarProtocolError(new Error("invalid stable_read fields"), JSON.stringify(parsed));
  }
  const bytes = Buffer.from(candidate.contentBase64, "base64");
  if (bytes.length !== candidate.size || bytes.length > maximumBytes) {
    throw new CustodySidecarProtocolError(new Error("stable_read payload does not match its bounds"), JSON.stringify(parsed));
  }
  return Object.freeze({ bytes, dev: candidate.dev, ino: candidate.ino });
}
async function publishDirectoryEligible(directory) {
  const absolute = resolve2(directory);
  try {
    const metadata = await lstat2(absolute);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || uid !== undefined && metadata.uid !== uid || (metadata.mode & 63) !== 0 || await realpath2(absolute) !== absolute || await realpath2(dirname3(absolute)) !== dirname3(absolute)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
function assertPublishName(name) {
  if (!publishNamePattern.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
}
async function rustAtomicPublish(binary, directory, name, content, createOnce) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const parsed = await runRequest(binary, {
    op: "atomic_publish",
    dir: resolve2(directory),
    name,
    contentBase64: bytes.toString("base64"),
    createOnce
  }, base64Bound(bytes.length) + ENVELOPE_SLACK_BYTES, FIXED_RESPONSE_BYTES);
  const candidate = parsed;
  if (!isRecord(parsed) || typeof candidate.path !== "string" || typeof candidate.created !== "boolean") {
    throw new CustodySidecarProtocolError(new Error("invalid atomic_publish fields"), JSON.stringify(parsed));
  }
  return { path: candidate.path, created: candidate.created };
}
async function rustReadProtectedDescriptor(binary, descriptor, maximumBytes) {
  const parsed = await runRequest(binary, { op: "read_protected_descriptor", fd: 3, maximumBytes }, FIXED_REQUEST_BYTES, maximumBytes * 6 + ENVELOPE_SLACK_BYTES, descriptor);
  const candidate = parsed;
  if (!isRecord(parsed) || typeof candidate.content !== "string") {
    throw new CustodySidecarProtocolError(new Error("invalid read_protected_descriptor fields"), JSON.stringify(parsed));
  }
  return candidate.content;
}
async function rustRequestControlSocket(binary, options) {
  const { socketPath, maximumResponseBytes, timeoutMs } = options;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new Error("Control response bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_CONTROL_TIMEOUT_MS) {
    throw new Error("Control request timeout must be a positive integer within one hour.");
  }
  const maximumRequestBytes = options.maximumRequestBytes ?? maximumResponseBytes;
  const frame = Buffer.from(`${JSON.stringify(options.request)}
`);
  if (frame.length > maximumRequestBytes) {
    throw new Error("Control request exceeds its frame limit.");
  }
  await assertOwnedPath(dirname3(socketPath), { kind: "directory", canonical: true });
  const parsed = await runRequest(binary, {
    op: "control_socket_request",
    socketPath,
    request: options.request,
    maximumResponseBytes,
    timeoutMs
  }, maximumRequestBytes + ENVELOPE_SLACK_BYTES, maximumResponseBytes * 2 + ENVELOPE_SLACK_BYTES);
  try {
    return options.parseResponse(parsed);
  } catch {
    throw new Error("Invalid control response.");
  }
}
function fallbackNotice(reason, inputClass) {
  emitLocalCustodyFallback(inputClass === undefined ? { tag: FALLBACK_TAG, reason } : { tag: FALLBACK_TAG, reason, inputClass });
}
function sidecarFailureReason(error) {
  return error instanceof CustodySidecarProtocolError ? "protocol-failed" : "spawn-failed";
}
async function rustOrTs(rust, ts) {
  try {
    return await rust();
  } catch (error) {
    if (error instanceof CustodyError || error instanceof TypeError)
      throw error;
    fallbackNotice(sidecarFailureReason(error));
    return ts();
  }
}
function descriptorClass(metadata) {
  if (metadata.isFIFO())
    return "fifo";
  if (metadata.isSocket())
    return "socket";
  if (metadata.isCharacterDevice())
    return "chardev";
  if (metadata.isBlockDevice())
    return "blockdev";
  return "other";
}
function typescriptEngine() {
  return {
    implementation: "typescript",
    ensurePrivateDirectory,
    assertOwnedPath,
    readOwnedFileStable,
    publishPrivateFile,
    createPrivateFileOnce,
    readProtectedDescriptor: (descriptor, options = {}) => Promise.resolve(readProtectedDescriptor(descriptor, options)),
    readProtectedStdin: (options = {}) => Promise.resolve(readProtectedStdin(options)),
    requestControlSocket,
    listenControlSocket,
    attachControlSocket
  };
}
async function loadLocalCustodyRustEngine() {
  let binaryPath = null;
  try {
    const { platform, arch } = currentPlatformArch();
    const candidate = sidecarBinaryPath(platform, arch);
    if ((await stat(candidate).catch(() => null))?.isFile())
      binaryPath = candidate;
  } catch {
    binaryPath = null;
  }
  if (binaryPath === null) {
    fallbackNotice("load-failed");
    return typescriptEngine();
  }
  const binary = binaryPath;
  return {
    implementation: "rust-sidecar",
    ensurePrivateDirectory: (path) => rustOrTs(() => rustEnsurePrivateDirectory(binary, path), () => ensurePrivateDirectory(path)),
    assertOwnedPath: (path, expectation) => {
      if (expectation.kind === "directory" && expectation.links === undefined || expectation.exactMode !== undefined && expectation.ownerOnly === true) {
        fallbackNotice("unsupported-input", "owned-path-shape");
        return assertOwnedPath(path, expectation);
      }
      return rustOrTs(() => rustAssertOwnedPath(binary, path, expectation), () => assertOwnedPath(path, expectation));
    },
    readOwnedFileStable: (path, maximumBytes, expectation = {}) => rustOrTs(() => rustReadOwnedFileStable(binary, path, maximumBytes, expectation), () => readOwnedFileStable(path, maximumBytes, expectation)),
    publishPrivateFile: async (directory, name, content, options = {}) => {
      assertPublishName(name);
      if (options.beforeCommit !== undefined) {
        fallbackNotice("unsupported-input", "commit-hook");
        return publishPrivateFile(directory, name, content, options);
      }
      if (!await publishDirectoryEligible(directory)) {
        fallbackNotice("unsupported-input", "directory-state");
        return publishPrivateFile(directory, name, content, options);
      }
      await rustOrTs(async () => {
        await rustAtomicPublish(binary, directory, name, content, false);
      }, () => publishPrivateFile(directory, name, content, options));
    },
    createPrivateFileOnce: async (directory, name, content) => {
      assertPublishName(name);
      if (!await publishDirectoryEligible(directory)) {
        fallbackNotice("unsupported-input", "directory-state");
        return createPrivateFileOnce(directory, name, content);
      }
      return rustOrTs(async () => {
        const published = await rustAtomicPublish(binary, directory, name, content, true);
        return published.created ? "created" : "existing";
      }, () => createPrivateFileOnce(directory, name, content));
    },
    readProtectedDescriptor: async (descriptor, options = {}) => {
      const maximumBytes = options.maximumBytes ?? DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES;
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
        throw new Error("Protected input bound must be a positive integer.");
      }
      if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
        throw new Error("Protected input requires a valid descriptor.");
      }
      const metadata = fstatSync3(descriptor);
      if (!metadata.isFile()) {
        fallbackNotice("unsupported-input", descriptorClass(metadata));
        return readProtectedDescriptor(descriptor, options);
      }
      return rustOrTs(() => rustReadProtectedDescriptor(binary, descriptor, maximumBytes), () => Promise.resolve(readProtectedDescriptor(descriptor, options)));
    },
    readProtectedStdin: (options = {}) => {
      fallbackNotice("unsupported-input", "stdin");
      return Promise.resolve(readProtectedStdin(options));
    },
    requestControlSocket: (options) => rustOrTs(() => rustRequestControlSocket(binary, options), () => requestControlSocket(options)),
    listenControlSocket,
    attachControlSocket
  };
}
export {
  sidecarBinaryPath,
  loadLocalCustodyRustEngine,
  CustodySidecarTimeoutError,
  CustodySidecarProtocolError,
  CustodySidecarNotFoundError,
  CustodyError
};
