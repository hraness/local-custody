import { spawn, type StdioOptions } from "node:child_process";
import { fstatSync } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Server } from "node:net";
import { fileURLToPath } from "node:url";

import {
  assertOwnedPath as tsAssertOwnedPath,
  ensurePrivateDirectory as tsEnsurePrivateDirectory,
  readOwnedFileStable as tsReadOwnedFileStable,
  type OwnedFileRead,
  type OwnedPathExpectation,
  type OwnedPathIdentity,
  type StableFileExpectation,
} from "./private-paths.js";
import {
  createPrivateFileOnce as tsCreatePrivateFileOnce,
  publishPrivateFile as tsPublishPrivateFile,
  type PublishPrivateFileOptions,
} from "./atomic-publish.js";
import {
  attachControlSocket as tsAttachControlSocket,
  listenControlSocket as tsListenControlSocket,
  requestControlSocket as tsRequestControlSocket,
  type ControlSocketRequestOptions,
  type ControlSocketServeOptions,
  type ControlSocketServer,
  type ControlSocketServerOptions,
  type ControlSocketTransport,
} from "./control-socket.js";
import {
  DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES,
  readProtectedDescriptor as tsReadProtectedDescriptor,
  readProtectedStdin as tsReadProtectedStdin,
} from "./protected-input.js";
import { emitLocalCustodyFallback } from "./rust-fallback.js";

const SPAWN_TIMEOUT_MS = 120_000;
const ENVELOPE_SLACK_BYTES = 16 * 1024;
const FIXED_REQUEST_BYTES = 16 * 1024;
const FIXED_RESPONSE_BYTES = 64 * 1024;
const FALLBACK_TAG = "local-custody-rust-fallback";
const MAXIMUM_CONTROL_TIMEOUT_MS = 3_600_000;
const publishNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class CustodySidecarNotFoundError extends Error {
  override readonly name: "CustodySidecarNotFoundError";
  constructor(
    readonly platform: string,
    readonly arch: string,
    readonly binaryPath: string,
  ) {
    super(`local-custody sidecar not found for ${platform}-${arch} at ${binaryPath}`);
    this.name = "CustodySidecarNotFoundError";
  }
}

export class CustodySidecarTimeoutError extends Error {
  override readonly name: "CustodySidecarTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`local-custody sidecar did not respond within ${timeoutMs} ms`);
    this.name = "CustodySidecarTimeoutError";
  }
}

export class CustodySidecarProtocolError extends Error {
  override readonly name: "CustodySidecarProtocolError";
  constructor(
    readonly reason: unknown,
    readonly stdout: string,
  ) {
    super(`local-custody sidecar produced unparseable output: ${String(reason)}`);
    this.name = "CustodySidecarProtocolError";
  }
}

/**
 * A domain failure reported by the sidecar: the request was well-formed and
 * the engine ran, but the custody check failed (`{ok:false,code,message}`).
 */
export class CustodyError extends Error {
  override readonly name: "CustodyError";
  constructor(
    readonly code: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(`local-custody sidecar op failed: ${code}`);
    this.name = "CustodyError";
  }
}

// ---------------------------------------------------------------------------
// Artifact location
// ---------------------------------------------------------------------------

function currentPlatformArch(): { platform: string; arch: string } {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") return { platform: "darwin", arch: "arm64" };
  if (platform === "darwin" && arch === "x64") return { platform: "darwin", arch: "x64" };
  if (platform === "linux" && arch === "x64") return { platform: "linux", arch: "x64" };
  throw new Error(`Unsupported platform for local-custody sidecar: ${platform}-${arch}`);
}

function artifactBaseDirectory(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = dirname(modulePath);
  const base = moduleDir.endsWith("/src") || moduleDir.endsWith("\\src")
    ? resolve(moduleDir, "..", "dist")
    : moduleDir;
  return resolve(base, "rust-artifacts", "local-custody");
}

/**
 * Path to the packaged `local-custody` sidecar binary. The
 * `HRANESS_LOCAL_CUSTODY_CLI_PATH` environment variable overrides the staged
 * artifact path (development and out-of-band sidecar delivery).
 */
export function sidecarBinaryPath(
  platform = currentPlatformArch().platform,
  arch = currentPlatformArch().arch,
): string {
  const override = process.env.HRANESS_LOCAL_CUSTODY_CLI_PATH;
  if (override !== undefined && override.length > 0) return resolve(override);
  return resolve(artifactBaseDirectory(), `${platform}-${arch}`, "local-custody");
}

// ---------------------------------------------------------------------------
// Bounded spawn protocol: one request line in, exactly one response line out
// ---------------------------------------------------------------------------

async function runSidecar(
  binaryPath: string,
  requestJson: string,
  maximumResponseBytes: number,
  sharedDescriptor?: number,
): Promise<string> {
  const stdio: StdioOptions = sharedDescriptor === undefined
    ? ["pipe", "pipe", "pipe"]
    : ["pipe", "pipe", "pipe", sharedDescriptor];
  const child = spawn(binaryPath, [], { stdio });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill("SIGKILL");
    throw new CustodySidecarProtocolError(new Error("sidecar stdio was not piped"), "");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === null) resolvePromise(value ?? "");
      else rejectPromise(error);
    };
    const failProtocol = (reason: unknown) => {
      child.kill("SIGKILL");
      finish(new CustodySidecarProtocolError(reason, Buffer.concat(chunks).toString("utf8")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new CustodySidecarTimeoutError(SPAWN_TIMEOUT_MS));
    }, SPAWN_TIMEOUT_MS);

    child.once("error", (error) => finish(error));
    stdin.once("error", (error) => finish(error));
    stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumResponseBytes) {
        failProtocol(new Error("response exceeds maximum length"));
        return;
      }
      chunks.push(chunk);
    });
    stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > ENVELOPE_SLACK_BYTES) failProtocol(new Error("stderr exceeds maximum length"));
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0 || signal !== null) {
        finish(new CustodySidecarProtocolError(
          new Error(`local-custody sidecar exited with code ${code ?? "unknown"}`),
          output,
        ));
        return;
      }
      const newline = output.indexOf("\n");
      if (newline < 0 || output.slice(newline + 1).trim().length !== 0) {
        finish(new CustodySidecarProtocolError(
          new Error("response must be exactly one JSON line"),
          output,
        ));
        return;
      }
      finish(null, output.slice(0, newline));
    });

    stdin.end(`${requestJson}\n`);
  });
}

// ---------------------------------------------------------------------------
// Request/response validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sidecarFailure(parsed: unknown): CustodyError | null {
  if (isRecord(parsed) && parsed.ok === false && typeof parsed.message === "string") {
    return new CustodyError(
      typeof parsed.code === "string" ? parsed.code : "unknown",
      parsed,
    );
  }
  return null;
}

function parseSidecarResponse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new CustodySidecarProtocolError(error, stdout);
  }
}

async function runRequest(
  binaryPath: string,
  request: Record<string, unknown>,
  maximumRequestBytes: number,
  maximumResponseBytes: number,
  sharedDescriptor?: number,
): Promise<unknown> {
  const requestJson = JSON.stringify(request);
  if (Buffer.byteLength(requestJson, "utf8") > maximumRequestBytes) {
    throw new TypeError("custody sidecar request exceeds maximum length");
  }
  const stdout = await runSidecar(binaryPath, requestJson, maximumResponseBytes, sharedDescriptor);
  const parsed = parseSidecarResponse(stdout);
  const failure = sidecarFailure(parsed);
  if (failure !== null) throw failure;
  return parsed;
}

function octalMode(exactMode: number): string {
  if (!Number.isSafeInteger(exactMode) || exactMode < 0 || exactMode > 0o7777) {
    throw new TypeError("exactMode must be a non-negative safe integer within mode bits");
  }
  return exactMode.toString(8).padStart(4, "0");
}

function boundedU64(value: bigint | number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const converted = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return converted;
}

function base64Bound(contentBytes: number): number {
  return Math.ceil(contentBytes * 4 / 3) + 8;
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

// ---------------------------------------------------------------------------
// Rust-backed operations
// ---------------------------------------------------------------------------

async function rustEnsurePrivateDirectory(binary: string, path: string): Promise<string> {
  const absolute = resolve(path);
  const parsed = await runRequest(
    binary,
    { op: "ensure_private_directory", path: absolute },
    FIXED_REQUEST_BYTES,
    FIXED_RESPONSE_BYTES,
  );
  const candidate = parsed as Record<string, unknown>;
  if (
    !isRecord(parsed)
    || candidate.path !== absolute
    || !isSafeCount(candidate.dev)
    || !isSafeCount(candidate.ino)
  ) {
    throw new CustodySidecarProtocolError(new Error("invalid ensure_private_directory fields"), JSON.stringify(parsed));
  }
  return candidate.path;
}

async function rustAssertOwnedPath(
  binary: string,
  path: string,
  expectation: OwnedPathExpectation,
): Promise<OwnedPathIdentity> {
  const request: Record<string, unknown> = { op: "assert_owned_path", path, kind: expectation.kind };
  if (expectation.exactMode !== undefined) request.exactMode = octalMode(expectation.exactMode);
  if (expectation.ownerOnly !== undefined) request.ownerOnly = expectation.ownerOnly;
  if (expectation.links !== undefined) request.links = boundedU64(expectation.links, "links");
  if (expectation.canonical !== undefined) request.canonical = expectation.canonical;
  const minimumBytes = boundedU64(expectation.minimumBytes, "minimumBytes");
  const maximumBytes = boundedU64(expectation.maximumBytes, "maximumBytes");
  if (minimumBytes !== undefined) request.minimumBytes = minimumBytes;
  if (maximumBytes !== undefined) request.maximumBytes = maximumBytes;
  const parsed = await runRequest(binary, request, FIXED_REQUEST_BYTES, FIXED_RESPONSE_BYTES);
  const candidate = parsed as Record<string, unknown>;
  if (
    !isRecord(parsed)
    || !isSafeCount(candidate.dev)
    || !isSafeCount(candidate.ino)
    || !isSafeCount(candidate.size)
  ) {
    throw new CustodySidecarProtocolError(new Error("invalid assert_owned_path fields"), JSON.stringify(parsed));
  }
  return Object.freeze({ dev: candidate.dev, ino: candidate.ino, size: candidate.size });
}

async function rustReadOwnedFileStable(
  binary: string,
  path: string,
  maximumBytes: number,
  expectation: StableFileExpectation,
): Promise<OwnedFileRead> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("maximumBytes must be a non-negative safe integer");
  }
  const request: Record<string, unknown> = {
    op: "stable_read",
    path,
    maximumBytes,
  };
  if (expectation.exactMode !== undefined) request.exactMode = octalMode(expectation.exactMode);
  if (expectation.ownerOnly !== undefined) request.ownerOnly = expectation.ownerOnly;
  if (expectation.links !== undefined) request.links = boundedU64(expectation.links, "links");
  const minimumBytes = boundedU64(expectation.minimumBytes, "minimumBytes");
  if (minimumBytes !== undefined) request.minimumBytes = minimumBytes;
  const parsed = await runRequest(
    binary,
    request,
    FIXED_REQUEST_BYTES,
    base64Bound(maximumBytes) + ENVELOPE_SLACK_BYTES,
  );
  const candidate = parsed as Record<string, unknown>;
  if (
    !isRecord(parsed)
    || !isSafeCount(candidate.dev)
    || !isSafeCount(candidate.ino)
    || !isSafeCount(candidate.size)
    || typeof candidate.contentBase64 !== "string"
    || !BASE64_PATTERN.test(candidate.contentBase64)
  ) {
    throw new CustodySidecarProtocolError(new Error("invalid stable_read fields"), JSON.stringify(parsed));
  }
  const bytes = Buffer.from(candidate.contentBase64, "base64");
  if (bytes.length !== candidate.size || bytes.length > maximumBytes) {
    throw new CustodySidecarProtocolError(new Error("stable_read payload does not match its bounds"), JSON.stringify(parsed));
  }
  return Object.freeze({ bytes, dev: candidate.dev, ino: candidate.ino });
}

/**
 * The Rust sidecar's `atomic_publish` calls `ensure_private_directory`
 * internally, which creates a missing directory and demands an owned,
 * owner-only, canonical directory — stricter than the TypeScript publish
 * path, which never creates the directory and never checks its mode. Only
 * directories that already satisfy the stricter contract take the Rust path.
 */
async function publishDirectoryEligible(directory: string): Promise<boolean> {
  const absolute = resolve(directory);
  try {
    const metadata = await lstat(absolute);
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isDirectory()
      || metadata.isSymbolicLink()
      || (uid !== undefined && metadata.uid !== uid)
      || (metadata.mode & 0o077) !== 0
      || (await realpath(absolute)) !== absolute
      || (await realpath(dirname(absolute))) !== dirname(absolute)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function assertPublishName(name: string): void {
  if (!publishNamePattern.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
}

async function rustAtomicPublish(
  binary: string,
  directory: string,
  name: string,
  content: string | Buffer,
  createOnce: boolean,
): Promise<{ path: string; created: boolean }> {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const parsed = await runRequest(
    binary,
    {
      op: "atomic_publish",
      dir: resolve(directory),
      name,
      contentBase64: bytes.toString("base64"),
      createOnce,
    },
    base64Bound(bytes.length) + ENVELOPE_SLACK_BYTES,
    FIXED_RESPONSE_BYTES,
  );
  const candidate = parsed as Record<string, unknown>;
  if (
    !isRecord(parsed)
    || typeof candidate.path !== "string"
    || typeof candidate.created !== "boolean"
  ) {
    throw new CustodySidecarProtocolError(new Error("invalid atomic_publish fields"), JSON.stringify(parsed));
  }
  return { path: candidate.path, created: candidate.created };
}

async function rustReadProtectedDescriptor(
  binary: string,
  descriptor: number,
  maximumBytes: number,
): Promise<string> {
  // The descriptor is shared with the child at fd 3 (after the protocol
  // pipes); the sidecar reads it without taking ownership.
  const parsed = await runRequest(
    binary,
    { op: "read_protected_descriptor", fd: 3, maximumBytes },
    FIXED_REQUEST_BYTES,
    maximumBytes * 6 + ENVELOPE_SLACK_BYTES,
    descriptor,
  );
  const candidate = parsed as Record<string, unknown>;
  if (!isRecord(parsed) || typeof candidate.content !== "string") {
    throw new CustodySidecarProtocolError(new Error("invalid read_protected_descriptor fields"), JSON.stringify(parsed));
  }
  return candidate.content;
}

async function rustRequestControlSocket<T>(
  binary: string,
  options: ControlSocketRequestOptions<T>,
): Promise<T> {
  const { socketPath, maximumResponseBytes, timeoutMs } = options;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
    throw new Error("Control response bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAXIMUM_CONTROL_TIMEOUT_MS) {
    throw new Error("Control request timeout must be a positive integer within one hour.");
  }
  const maximumRequestBytes = options.maximumRequestBytes ?? maximumResponseBytes;
  const frame = Buffer.from(`${JSON.stringify(options.request)}\n`);
  if (frame.length > maximumRequestBytes) {
    throw new Error("Control request exceeds its frame limit.");
  }
  // The TypeScript client never creates the socket's directory; keep that
  // contract on the Rust path (the sidecar's own validation would create it).
  await tsAssertOwnedPath(dirname(socketPath), { kind: "directory", canonical: true });
  const parsed = await runRequest(
    binary,
    {
      op: "control_socket_request",
      socketPath,
      request: options.request,
      maximumResponseBytes,
      timeoutMs,
    },
    maximumRequestBytes + ENVELOPE_SLACK_BYTES,
    maximumResponseBytes * 2 + ENVELOPE_SLACK_BYTES,
  );
  // A `{ok:false,...}` body without `message` is the socket's own failure
  // envelope, not a sidecar failure — it passes through to the product parser.
  try {
    return options.parseResponse(parsed);
  } catch {
    throw new Error("Invalid control response.");
  }
}

// ---------------------------------------------------------------------------
// Engine assembly
// ---------------------------------------------------------------------------

export type LocalCustodyRustEngine = Readonly<{
  /**
   * "rust-sidecar" when the packaged native binary handles the delegatable
   * operations; "typescript" when every operation runs the TypeScript
   * implementation.
   */
  implementation: "rust-sidecar" | "typescript";
  ensurePrivateDirectory(path: string): Promise<string>;
  assertOwnedPath(path: string, expectation: OwnedPathExpectation): Promise<OwnedPathIdentity>;
  readOwnedFileStable(
    path: string,
    maximumBytes: number,
    expectation?: StableFileExpectation,
  ): Promise<OwnedFileRead>;
  publishPrivateFile(
    directory: string,
    name: string,
    content: string | Buffer,
    options?: PublishPrivateFileOptions,
  ): Promise<void>;
  createPrivateFileOnce(
    directory: string,
    name: string,
    content: string | Buffer,
  ): Promise<"created" | "existing">;
  readProtectedDescriptor(
    descriptor: number,
    options?: Readonly<{ maximumBytes?: number }>,
  ): Promise<string>;
  readProtectedStdin(options?: Readonly<{ maximumBytes?: number }>): Promise<string>;
  requestControlSocket<T>(options: ControlSocketRequestOptions<T>): Promise<T>;
  /** Server lifecycle stays TypeScript-only. */
  listenControlSocket(options: ControlSocketServerOptions): Promise<ControlSocketServer>;
  attachControlSocket(server: Server, options: ControlSocketServeOptions): ControlSocketTransport;
}>;

type FallbackReason = "load-failed" | "spawn-failed" | "protocol-failed" | "unsupported-input";

function fallbackNotice(reason: FallbackReason, inputClass?: string): void {
  emitLocalCustodyFallback(
    inputClass === undefined ? { tag: FALLBACK_TAG, reason } : { tag: FALLBACK_TAG, reason, inputClass },
  );
}

function sidecarFailureReason(error: unknown): FallbackReason {
  return error instanceof CustodySidecarProtocolError ? "protocol-failed" : "spawn-failed";
}

/**
 * Run `rust` first; transport-level sidecar failures (missing binary, spawn,
 * timeout, protocol violations) fall back to the TypeScript implementation
 * with a bounded stderr notice. Domain failures ({@link CustodyError}) are
 * authoritative and propagate; invalid input ({@link TypeError}) propagates.
 */
async function rustOrTs<T>(rust: () => Promise<T>, ts: () => Promise<T>): Promise<T> {
  try {
    return await rust();
  } catch (error) {
    if (error instanceof CustodyError || error instanceof TypeError) throw error;
    fallbackNotice(sidecarFailureReason(error));
    return ts();
  }
}

function descriptorClass(metadata: ReturnType<typeof fstatSync>): string {
  if (metadata.isFIFO()) return "fifo";
  if (metadata.isSocket()) return "socket";
  if (metadata.isCharacterDevice()) return "chardev";
  if (metadata.isBlockDevice()) return "blockdev";
  return "other";
}

function typescriptEngine(): LocalCustodyRustEngine {
  return {
    implementation: "typescript",
    ensurePrivateDirectory: tsEnsurePrivateDirectory,
    assertOwnedPath: tsAssertOwnedPath,
    readOwnedFileStable: tsReadOwnedFileStable,
    publishPrivateFile: tsPublishPrivateFile,
    createPrivateFileOnce: tsCreatePrivateFileOnce,
    readProtectedDescriptor: (descriptor, options = {}) =>
      Promise.resolve(tsReadProtectedDescriptor(descriptor, options)),
    readProtectedStdin: (options = {}) => Promise.resolve(tsReadProtectedStdin(options)),
    requestControlSocket: tsRequestControlSocket,
    listenControlSocket: tsListenControlSocket,
    attachControlSocket: tsAttachControlSocket,
  };
}

/**
 * Load the custody engine that prefers the packaged Rust sidecar binary and
 * falls back to the TypeScript implementation operation by operation.
 *
 * The binary is probed once at load time; when it is absent every operation
 * delegates to TypeScript directly. When it is present, each operation runs
 * through the bounded JSON-lines sidecar protocol unless the input shape is
 * one the Rust engine cannot faithfully reproduce (a `beforeCommit` hook,
 * directory assertions without an explicit link bound, non-regular protected
 * descriptors, stdin, or the control-socket server lifecycle) — those run the
 * TypeScript path with a bounded fallback notice.
 */
export async function loadLocalCustodyRustEngine(): Promise<LocalCustodyRustEngine> {
  let binaryPath: string | null = null;
  try {
    const { platform, arch } = currentPlatformArch();
    const candidate = sidecarBinaryPath(platform, arch);
    if ((await stat(candidate).catch(() => null))?.isFile()) binaryPath = candidate;
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

    ensurePrivateDirectory: (path) => rustOrTs(
      () => rustEnsurePrivateDirectory(binary, path),
      () => tsEnsurePrivateDirectory(path),
    ),

    assertOwnedPath: (path, expectation) => {
      // The sidecar defaults link count to 1 for every kind (the TypeScript
      // contract skips the check for directories) and checks `ownerOnly` only
      // when `exactMode` is absent — delegate both divergent shapes.
      if (
        (expectation.kind === "directory" && expectation.links === undefined)
        || (expectation.exactMode !== undefined && expectation.ownerOnly === true)
      ) {
        fallbackNotice("unsupported-input", "owned-path-shape");
        return tsAssertOwnedPath(path, expectation);
      }
      return rustOrTs(
        () => rustAssertOwnedPath(binary, path, expectation),
        () => tsAssertOwnedPath(path, expectation),
      );
    },

    readOwnedFileStable: (path, maximumBytes, expectation = {}) => rustOrTs(
      () => rustReadOwnedFileStable(binary, path, maximumBytes, expectation),
      () => tsReadOwnedFileStable(path, maximumBytes, expectation),
    ),

    publishPrivateFile: async (directory, name, content, options = {}) => {
      assertPublishName(name);
      if (options.beforeCommit !== undefined) {
        fallbackNotice("unsupported-input", "commit-hook");
        return tsPublishPrivateFile(directory, name, content, options);
      }
      if (!(await publishDirectoryEligible(directory))) {
        fallbackNotice("unsupported-input", "directory-state");
        return tsPublishPrivateFile(directory, name, content, options);
      }
      await rustOrTs(
        async () => { await rustAtomicPublish(binary, directory, name, content, false); },
        () => tsPublishPrivateFile(directory, name, content, options),
      );
    },

    createPrivateFileOnce: async (directory, name, content) => {
      assertPublishName(name);
      if (!(await publishDirectoryEligible(directory))) {
        fallbackNotice("unsupported-input", "directory-state");
        return tsCreatePrivateFileOnce(directory, name, content);
      }
      return rustOrTs(
        async () => {
          const published = await rustAtomicPublish(binary, directory, name, content, true);
          return published.created ? "created" as const : "existing" as const;
        },
        () => tsCreatePrivateFileOnce(directory, name, content),
      );
    },

    readProtectedDescriptor: async (descriptor, options = {}) => {
      const maximumBytes = options.maximumBytes ?? DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES;
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
        throw new Error("Protected input bound must be a positive integer.");
      }
      if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
        throw new Error("Protected input requires a valid descriptor.");
      }
      // The Rust engine accepts regular files only; pipes, sockets, devices,
      // and terminals keep the TypeScript path (which accepts and reads them).
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile()) {
        fallbackNotice("unsupported-input", descriptorClass(metadata));
        return tsReadProtectedDescriptor(descriptor, options);
      }
      return rustOrTs(
        () => rustReadProtectedDescriptor(binary, descriptor, maximumBytes),
        () => Promise.resolve(tsReadProtectedDescriptor(descriptor, options)),
      );
    },

    readProtectedStdin: (options = {}) => {
      // stdin carries the sidecar protocol, so protected stdin is TypeScript-only.
      fallbackNotice("unsupported-input", "stdin");
      return Promise.resolve(tsReadProtectedStdin(options));
    },

    requestControlSocket: <T>(options: ControlSocketRequestOptions<T>) => rustOrTs(
      () => rustRequestControlSocket(binary, options),
      () => tsRequestControlSocket(options),
    ),

    listenControlSocket: tsListenControlSocket,
    attachControlSocket: tsAttachControlSocket,
  };
}
