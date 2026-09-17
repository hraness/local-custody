// src/private-paths.ts
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var ownerUid = () => typeof process.getuid === "function" ? process.getuid() : undefined;
var kindMatches = (metadata, kind) => kind === "file" ? metadata.isFile() : kind === "directory" ? metadata.isDirectory() : metadata.isSocket();
async function assertOwnedPath(path, expectation) {
  const metadata = await lstat(path, { bigint: true });
  const uid = ownerUid();
  const expectedLinks = expectation.links ?? (expectation.kind === "directory" ? undefined : 1n);
  if (!kindMatches(metadata, expectation.kind) || metadata.isSymbolicLink() || expectedLinks !== undefined && metadata.nlink !== BigInt(expectedLinks) || uid !== undefined && metadata.uid !== BigInt(uid) || expectation.exactMode !== undefined && (metadata.mode & 0o777n) !== BigInt(expectation.exactMode) || expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes || expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
}
async function ensurePrivateDirectory(path) {
  const resolved = resolve(path);
  const parent = await realpath(dirname(resolved));
  const absolute = join(parent, basename(resolved));
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
import { constants as constants2 } from "node:fs";
import { open as open2, rename, unlink } from "node:fs/promises";
import { join as join2 } from "node:path";
var safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;
async function publishPrivateFile(directory, name, content) {
  if (!safeFileName.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
  const temporary = join2(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open2(temporary, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join2(directory, name));
    await assertOwnedPath(join2(directory, name), {
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

// src/control-socket.ts
import { chmod, lstat as lstat2, unlink as unlink2 } from "node:fs/promises";
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
async function socketIdentity(path) {
  await assertOwnedPath(path, { kind: "socket", exactMode: PRIVATE_FILE_MODE, links: 1 });
  const metadata = await lstat2(path);
  return { dev: metadata.dev, ino: metadata.ino };
}
var sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
async function listenControlSocket(options) {
  const socketPath = options.socketPath;
  if (Buffer.byteLength(socketPath) > MAXIMUM_SOCKET_PATH_BYTES) {
    throw new Error("Control socket path exceeds its platform limit.");
  }
  const maximumFrameBytes = options.maximumFrameBytes;
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
    throw new Error("Control frame bound must be a positive integer.");
  }
  const maximumResponseBytes = options.maximumResponseBytes ?? maximumFrameBytes;
  const maximumConnections = boundedCount(options.maximumConnections, DEFAULT_MAXIMUM_CONNECTIONS, 1024);
  const maximumRequests = boundedCount(options.maximumRequestsPerConnection, 1, 1024);
  const headerTimeoutMs = boundedTimeoutMs(options.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS);
  const idleTimeoutMs = boundedTimeoutMs(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  await ensurePrivateDirectory(dirname2(socketPath));
  try {
    await assertOwnedPath(socketPath, { kind: "socket", exactMode: PRIVATE_FILE_MODE });
    await unlink2(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }
  const encode = (value) => {
    const bytes = Buffer.from(`${JSON.stringify(value)}
`);
    if (bytes.length <= maximumResponseBytes)
      return bytes;
    return Buffer.from(`${JSON.stringify(options.failureResponse)}
`);
  };
  const clients = new Set;
  const work = new Set;
  let closing = false;
  const server = createServer((socket) => {
    if (closing || clients.size >= maximumConnections) {
      socket.end(encode(options.failureResponse));
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
    const headerTimer = setTimeout(() => socket.destroy(), headerTimeoutMs);
    headerTimer.unref();
    const armIdle = () => {
      if (idleTimer !== undefined)
        clearTimeout(idleTimer);
      if (requests >= maximumRequests)
        return;
      idleTimer = setTimeout(() => socket.destroy(), idleTimeoutMs);
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
          if (received.byteLength > maximumFrameBytes)
            socket.destroy();
          return;
        }
        if (newline === 0 || newline + 1 > maximumFrameBytes || requests >= maximumRequests) {
          socket.end(encode(options.failureResponse));
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
            response = options.failureResponse;
          }
          if (!socket.destroyed && !socket.writableEnded) {
            const bytes = encode(response);
            if (socket.writableLength + bytes.length > maximumResponseBytes) {
              socket.destroy();
            } else {
              socket.write(bytes, () => {
                if (requests >= maximumRequests)
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
  try {
    await new Promise((resolve2, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve2();
      });
    });
    await chmod(socketPath, PRIVATE_FILE_MODE);
    await socketIdentity(socketPath);
  } catch (error) {
    for (const client of clients)
      client.destroy();
    await new Promise((resolve2) => server.close(() => resolve2()));
    throw error;
  }
  let closePromise;
  return {
    socketPath,
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const client of clients)
          client.destroy();
        const failures = [];
        try {
          await new Promise((resolve2, reject) => server.close((error) => error ? reject(error) : resolve2()));
        } catch (error) {
          failures.push(error);
        }
        await Promise.allSettled([...work]);
        try {
          const identity = await socketIdentity(socketPath).catch(() => null);
          if (identity !== null)
            await unlink2(socketPath);
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Control socket cleanup requires attention.");
        }
      })();
      return closePromise;
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
  await ensurePrivateDirectory(dirname2(socketPath));
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
      buffer = Buffer.concat([buffer, chunk]);
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
import { fstatSync, readSync } from "node:fs";
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
  const metadata = fstatSync(descriptor, { bigint: true });
  if (metadata.isFile()) {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && metadata.uid !== BigInt(uid) || (metadata.mode & 0o077n) !== 0n) {
      throw new Error("Protected input file must be owned and private.");
    }
  }
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (true) {
    const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
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
export {
  requestControlSocket,
  readProtectedStdin,
  readProtectedDescriptor,
  readPrivateFile,
  publishPrivateFile,
  listenControlSocket,
  ensurePrivateDirectory,
  assertOwnedPath,
  PRIVATE_FILE_MODE,
  PRIVATE_DIRECTORY_MODE,
  MAXIMUM_SOCKET_PATH_BYTES,
  DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES
};
