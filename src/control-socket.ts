import { chmod, unlink } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import {
  PRIVATE_FILE_MODE,
  assertOwnedPath,
  ensurePrivateDirectory,
  type OwnedPathIdentity,
} from "./private-paths.js";

/** `sockaddr_un.sun_path` is 104 bytes on supported platforms; stay under it. */
export const MAXIMUM_SOCKET_PATH_BYTES = 100;
const DEFAULT_MAXIMUM_CONNECTIONS = 16;
const DEFAULT_HEADER_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const MAXIMUM_TIMEOUT_MS = 3_600_000;

const boundedTimeoutMs = (value: number | undefined, fallback: number): number => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > MAXIMUM_TIMEOUT_MS) {
    throw new Error("Control socket timeouts must be positive integers within one hour.");
  }
  return candidate;
};

const boundedCount = (value: number | undefined, fallback: number, maximum: number): number => {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new Error("Control socket bounds must be positive integers.");
  }
  return candidate;
};

const socketIdentity = (path: string): Promise<OwnedPathIdentity> =>
  assertOwnedPath(path, { kind: "socket", exactMode: PRIVATE_FILE_MODE, links: 1 });

const sameIdentity = (left: OwnedPathIdentity, right: OwnedPathIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

/** Why the transport is writing a failure envelope instead of a response. */
export type ControlSocketFailureReason =
  /** The listener is closing or at its connection bound. */
  | "capacity"
  /** The frame is empty, oversized, or past the per-connection request bound. */
  | "limit"
  /** The frame is not bounded UTF-8 JSON, or the handler threw. */
  | "invalid-request"
  /** The encoded response exceeded the response bound. */
  | "response-limit";

export interface ControlSocketServeOptions {
  /** Maximum bytes for one request frame and, by default, one response frame. */
  readonly maximumFrameBytes: number;
  /** Defaults to `maximumFrameBytes`. */
  readonly maximumResponseBytes?: number;
  readonly maximumConnections?: number;
  /** Requests accepted per connection before close. Defaults to 1. */
  readonly maximumRequestsPerConnection?: number;
  /** Deadline to deliver the first complete frame. Defaults to 5s. */
  readonly headerTimeoutMs?: number;
  /** Idle bound between frames on pipelined connections. Defaults to 10s. */
  readonly idleTimeoutMs?: number;
  /** Maps a request value to the product's response value. Throwing writes a failure envelope. */
  readonly onRequest: (request: unknown, context: Readonly<{ signal: AbortSignal }>) => unknown;
  /** Maps a failure reason to the product's wire envelope. For a fixed body pass a constant function. */
  readonly failureResponse: (reason: ControlSocketFailureReason) => unknown;
}

export interface ControlSocketTransport {
  /** Stop accepting, destroy clients, and await in-flight requests. Does not unlink. */
  close(): Promise<void>;
}

interface ResolvedBounds {
  readonly maximumFrameBytes: number;
  readonly maximumResponseBytes: number;
  readonly maximumConnections: number;
  readonly maximumRequests: number;
  readonly headerTimeoutMs: number;
  readonly idleTimeoutMs: number;
}

const resolveBounds = (options: ControlSocketServeOptions): ResolvedBounds => {
  const maximumFrameBytes = options.maximumFrameBytes;
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
    throw new Error("Control frame bound must be a positive integer.");
  }
  return {
    maximumFrameBytes,
    maximumResponseBytes: options.maximumResponseBytes ?? maximumFrameBytes,
    maximumConnections: boundedCount(
      options.maximumConnections, DEFAULT_MAXIMUM_CONNECTIONS, 1_024,
    ),
    maximumRequests: boundedCount(
      options.maximumRequestsPerConnection, 1, 1_024,
    ),
    headerTimeoutMs: boundedTimeoutMs(
      options.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS,
    ),
    idleTimeoutMs: boundedTimeoutMs(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
  };
};

/**
 * Serve bounded newline-delimited JSON on an already-created `net.Server`.
 *
 * Attach before `server.listen()` (or before any connection can arrive). The
 * caller owns the server's bind, filesystem name, and lifecycle; `close()`
 * performs transport teardown only.
 */
export function attachControlSocket(
  server: Server,
  options: ControlSocketServeOptions,
): ControlSocketTransport {
  const bounds = resolveBounds(options);
  const failure = options.failureResponse;

  const encode = (value: unknown, reason: ControlSocketFailureReason): Buffer => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length <= bounds.maximumResponseBytes) return bytes;
    const fallback = Buffer.from(`${JSON.stringify(failure(reason))}\n`);
    if (fallback.length <= bounds.maximumResponseBytes) return fallback;
    return Buffer.alloc(0);
  };

  const clients = new Set<Socket>();
  const work = new Set<Promise<unknown>>();
  let closing = false;

  server.on("connection", (socket) => {
    if (closing || clients.size >= bounds.maximumConnections) {
      const bytes = encode(failure("capacity"), "capacity");
      if (bytes.length === 0) socket.destroy();
      else socket.end(bytes);
      return;
    }
    clients.add(socket);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    socket.once("close", () => {
      clients.delete(socket);
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    });
    socket.on("error", () => undefined);
    const controller = new AbortController();
    let received = Buffer.alloc(0);
    let requests = 0;
    let chain: Promise<unknown> = Promise.resolve();
    const headerTimer = setTimeout(() => socket.destroy(), bounds.headerTimeoutMs);
    headerTimer.unref();
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (requests >= bounds.maximumRequests) return;
      idleTimer = setTimeout(() => socket.destroy(), bounds.idleTimeoutMs);
      idleTimer.unref();
    };
    socket.on("data", (chunk) => {
      if (closing) { socket.destroy(); return; }
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (true) {
        const newline = received.indexOf(0x0a);
        if (newline < 0) {
          // A buffer at the bound with no newline can never complete a frame.
          if (received.byteLength >= bounds.maximumFrameBytes) socket.destroy();
          return;
        }
        if (newline === 0 || newline + 1 > bounds.maximumFrameBytes || requests >= bounds.maximumRequests) {
          const bytes = encode(failure("limit"), "limit");
          if (bytes.length === 0) socket.destroy();
          else socket.end(bytes);
          return;
        }
        const frame = received.subarray(0, newline);
        received = received.subarray(newline + 1);
        requests += 1;
        clearTimeout(headerTimer);
        const task = chain.catch(() => undefined).then(async () => {
          if (closing || socket.destroyed) return;
          let response: unknown;
          try {
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
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
                if (requests >= bounds.maximumRequests) socket.end();
                else armIdle();
              });
            }
          }
        }).finally(() => work.delete(task));
        work.add(task);
        chain = task;
      }
    });
    socket.on("end", () => {
      if (received.byteLength !== 0) socket.destroy();
    });
  });

  let closePromise: Promise<void> | undefined;
  return {
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const client of clients) client.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (
            error !== undefined
            && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
              ? reject(error)
              : resolve())));
        await Promise.allSettled([...work]);
      })();
      return closePromise;
    },
  };
}

export interface ControlSocketServerOptions extends ControlSocketServeOptions {
  /** Socket path inside a private directory. Byte length must stay under {@link MAXIMUM_SOCKET_PATH_BYTES}. */
  readonly socketPath: string;
}

export interface ControlSocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Owner-only newline-delimited JSON control socket.
 *
 * The listener lives inside a proved private directory; a stale owned socket
 * is removed and the fresh socket is re-validated (owner, mode 0600, single
 * link, real socket) after chmod. Each connection carries bounded UTF-8 JSON
 * frames; oversize input destroys the connection and handler failures never
 * escape as transport errors. `close()` unlinks the socket only while it is
 * still the exact inode this listener published.
 */
export async function listenControlSocket(
  options: ControlSocketServerOptions,
): Promise<ControlSocketServer> {
  const socketPath = options.socketPath;
  if (Buffer.byteLength(socketPath) > MAXIMUM_SOCKET_PATH_BYTES) {
    throw new Error("Control socket path exceeds its platform limit.");
  }

  await ensurePrivateDirectory(dirname(socketPath));
  try {
    await socketIdentity(socketPath);
    await unlink(socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const server = createServer();
  const transport = attachControlSocket(server, options);
  let published: OwnedPathIdentity;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, PRIVATE_FILE_MODE);
    published = await socketIdentity(socketPath);
  } catch (error: unknown) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  return {
    socketPath,
    async close() {
      const failures: unknown[] = [];
      try {
        await transport.close();
      } catch (error: unknown) { failures.push(error); }
      try {
        const current = await socketIdentity(socketPath).catch(() => null);
        if (current !== null && sameIdentity(current, published)) {
          await unlink(socketPath);
        }
      } catch (error: unknown) { failures.push(error); }
      if (failures.length > 0) {
        throw failures.length === 1
          ? failures[0]
          : new AggregateError(failures, "Control socket cleanup requires attention.");
      }
    },
  };
}

export interface ControlSocketRequestOptions<T> {
  readonly socketPath: string;
  readonly request: unknown;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes: number;
  /** Whole-request deadline. */
  readonly timeoutMs: number;
  /** Narrow the decoded response value from `unknown`. */
  readonly parseResponse: (value: unknown) => T;
}

/**
 * Send exactly one bounded request frame to a control socket and return the
 * narrowed response. The containing directory and the socket's dev/ino
 * identity are validated — never created — and re-validated after connect so
 * a replaced endpoint cannot intercept the request.
 */
export async function requestControlSocket<T>(
  options: ControlSocketRequestOptions<T>,
): Promise<T> {
  const { socketPath, maximumResponseBytes, timeoutMs } = options;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new Error("Control response bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_TIMEOUT_MS) {
    throw new Error("Control request timeout must be a positive integer within one hour.");
  }
  const maximumRequestBytes = options.maximumRequestBytes ?? maximumResponseBytes;
  const frame = Buffer.from(`${JSON.stringify(options.request)}\n`);
  if (frame.length > maximumRequestBytes) {
    throw new Error("Control request exceeds its frame limit.");
  }
  await assertOwnedPath(dirname(socketPath), { kind: "directory", canonical: true });
  const before = await socketIdentity(socketPath);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const socket = connect(socketPath);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const settle = (error: Error | null, value?: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error !== null) rejectPromise(error);
      else resolvePromise(value as T);
    };
    const timer = setTimeout(
      () => settle(new Error("Control request timed out.")),
      timeoutMs,
    );
    socket.once("connect", () => {
      void socketIdentity(socketPath).then((after) => {
        if (!sameIdentity(before, after)) throw new Error("Control socket identity changed.");
        if (!settled) socket.write(frame);
      }).catch((error: unknown) =>
        settle(error instanceof Error ? error : new Error("Control socket changed.")));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > maximumResponseBytes) {
        settle(new Error("Control response exceeds its frame limit."));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline !== buffer.length - 1) {
        settle(new Error("Unexpected additional control output."));
        return;
      }
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline)),
        );
        settle(null, options.parseResponse(value));
      } catch {
        settle(new Error("Invalid control response."));
      }
    });
    socket.once("error", () => settle(new Error("The control socket is unavailable.")));
    socket.once("close", () => {
      if (!settled) settle(new Error("The control socket closed without a response."));
    });
  });
}
