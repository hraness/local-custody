import { chmod, lstat, unlink } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { dirname } from "node:path";

import { PRIVATE_FILE_MODE, assertOwnedPath, ensurePrivateDirectory } from "./private-paths.js";

/** `sockaddr_un.sun_path` is 104 bytes on supported platforms; stay under it. */
export const MAXIMUM_SOCKET_PATH_BYTES = 100;
const DEFAULT_MAXIMUM_CONNECTIONS = 16;
const DEFAULT_HEADER_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const MAXIMUM_TIMEOUT_MS = 3_600_000;

type SocketIdentity = Readonly<{ dev: number; ino: number }>;

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

async function socketIdentity(path: string): Promise<SocketIdentity> {
  await assertOwnedPath(path, { kind: "socket", exactMode: PRIVATE_FILE_MODE, links: 1 });
  const metadata = await lstat(path);
  return { dev: metadata.dev, ino: metadata.ino };
}

const sameIdentity = (left: SocketIdentity, right: SocketIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

export interface ControlSocketServerOptions {
  /** Socket path inside a private directory. Byte length must stay under {@link MAXIMUM_SOCKET_PATH_BYTES}. */
  readonly socketPath: string;
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
  /** Maps a request value to the product's response value. Throwing writes `failureResponse`. */
  readonly onRequest: (request: unknown, context: Readonly<{ signal: AbortSignal }>) => unknown;
  /** Fixed product envelope written when a frame cannot be parsed or the handler throws. */
  readonly failureResponse: unknown;
}

export interface ControlSocketServer {
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Owner-only newline-delimited JSON control socket.
 *
 * The listener lives inside a proved private directory; the socket file is
 * re-validated (owner, mode 0600, single link, real socket) after chmod. Each
 * connection carries bounded UTF-8 JSON frames; oversize input destroys the
 * connection and handler failures never escape as transport errors.
 */
export async function listenControlSocket(
  options: ControlSocketServerOptions,
): Promise<ControlSocketServer> {
  const socketPath = options.socketPath;
  if (Buffer.byteLength(socketPath) > MAXIMUM_SOCKET_PATH_BYTES) {
    throw new Error("Control socket path exceeds its platform limit.");
  }
  const maximumFrameBytes = options.maximumFrameBytes;
  if (!Number.isSafeInteger(maximumFrameBytes) || maximumFrameBytes < 1) {
    throw new Error("Control frame bound must be a positive integer.");
  }
  const maximumResponseBytes = options.maximumResponseBytes ?? maximumFrameBytes;
  const maximumConnections = boundedCount(
    options.maximumConnections, DEFAULT_MAXIMUM_CONNECTIONS, 1_024,
  );
  const maximumRequests = boundedCount(
    options.maximumRequestsPerConnection, 1, 1_024,
  );
  const headerTimeoutMs = boundedTimeoutMs(
    options.headerTimeoutMs, DEFAULT_HEADER_TIMEOUT_MS,
  );
  const idleTimeoutMs = boundedTimeoutMs(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);

  await ensurePrivateDirectory(dirname(socketPath));
  try {
    await assertOwnedPath(socketPath, { kind: "socket", exactMode: PRIVATE_FILE_MODE });
    await unlink(socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const encode = (value: unknown): Buffer => {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (bytes.length <= maximumResponseBytes) return bytes;
    return Buffer.from(`${JSON.stringify(options.failureResponse)}\n`);
  };

  const clients = new Set<Socket>();
  const work = new Set<Promise<unknown>>();
  let closing = false;

  const server = createServer((socket) => {
    if (closing || clients.size >= maximumConnections) {
      socket.end(encode(options.failureResponse));
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
    const headerTimer = setTimeout(() => socket.destroy(), headerTimeoutMs);
    headerTimer.unref();
    const armIdle = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (requests >= maximumRequests) return;
      idleTimer = setTimeout(() => socket.destroy(), idleTimeoutMs);
      idleTimer.unref();
    };
    socket.on("data", (chunk) => {
      if (closing) { socket.destroy(); return; }
      received = Buffer.concat([received, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (true) {
        const newline = received.indexOf(0x0a);
        if (newline < 0) {
          if (received.byteLength > maximumFrameBytes) socket.destroy();
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
        const task = chain.catch(() => undefined).then(async () => {
          if (closing || socket.destroyed) return;
          let response: unknown;
          try {
            const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
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
                if (requests >= maximumRequests) socket.end();
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

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(socketPath, PRIVATE_FILE_MODE);
    await socketIdentity(socketPath);
  } catch (error: unknown) {
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  return {
    socketPath,
    close() {
      closePromise ??= (async () => {
        closing = true;
        for (const client of clients) client.destroy();
        const failures: unknown[] = [];
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())));
        } catch (error: unknown) { failures.push(error); }
        await Promise.allSettled([...work]);
        try {
          const identity = await socketIdentity(socketPath).catch(() => null);
          if (identity !== null) await unlink(socketPath);
        } catch (error: unknown) { failures.push(error); }
        if (failures.length > 0) {
          throw failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Control socket cleanup requires attention.");
        }
      })();
      return closePromise;
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
 * narrowed response. The socket's dev/ino identity is re-validated after
 * connect so a replaced endpoint cannot intercept the request.
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
  await ensurePrivateDirectory(dirname(socketPath));
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
      buffer = Buffer.concat([buffer, chunk]);
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
