import {
  PRIVATE_FILE_MODE,
  assertOwnedPath,
  ensurePrivateDirectory
} from "./chunk-xrgz1k0h.js";

// src/control-socket.ts
import { chmod, unlink } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { dirname } from "node:path";
class ControlSocketError extends Error {
  name = "ControlSocketError";
  code;
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}
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
        await new Promise((resolve, reject) => server.close((error) => error !== undefined && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
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
  await ensurePrivateDirectory(dirname(socketPath));
  try {
    await socketIdentity(socketPath);
    await unlink(socketPath);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw error;
  }
  const server = createServer();
  const transport = attachControlSocket(server, options);
  let published;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
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
          await unlink(socketPath);
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
  let before;
  try {
    await assertOwnedPath(dirname(socketPath), { kind: "directory", canonical: true });
    before = await socketIdentity(socketPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ControlSocketError("control-unavailable", "The control socket is unavailable.", { cause: error });
    }
    throw error;
  }
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
    const timer = setTimeout(() => settle(new ControlSocketError("control-timeout", "Control request timed out.")), timeoutMs);
    socket.once("connect", () => {
      socketIdentity(socketPath).then((after) => {
        if (!sameIdentity(before, after))
          throw new ControlSocketError("control-identity-changed", "Control socket identity changed.");
        if (!settled)
          socket.write(frame);
      }).catch((error) => settle(error instanceof Error ? error : new Error("Control socket changed.")));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > maximumResponseBytes) {
        settle(new ControlSocketError("control-response-too-large", "Control response exceeds its frame limit."));
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0)
        return;
      if (newline !== buffer.length - 1) {
        settle(new ControlSocketError("control-extra-output", "Unexpected additional control output."));
        return;
      }
      try {
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)));
        settle(null, options.parseResponse(value));
      } catch {
        settle(new ControlSocketError("control-invalid-response", "Invalid control response."));
      }
    });
    socket.once("error", () => settle(new ControlSocketError("control-unavailable", "The control socket is unavailable.")));
    socket.once("close", () => {
      if (!settled)
        settle(new ControlSocketError("control-closed", "The control socket closed without a response."));
    });
  });
}

export { ControlSocketError, MAXIMUM_SOCKET_PATH_BYTES, attachControlSocket, listenControlSocket, requestControlSocket };
