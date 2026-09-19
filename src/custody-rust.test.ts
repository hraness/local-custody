import { chmodSync, openSync, realpathSync, writeSync, closeSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
  CustodyError,
  loadLocalCustodyRustEngine,
  sidecarBinaryPath,
} from "./custody-rust";
import type { LocalCustodyRustEngine } from "./custody-rust";

const SIDECAR_ENV = "HRANESS_LOCAL_CUSTODY_CLI_PATH";

async function ensureSidecarPath(): Promise<string> {
  const envPath = process.env[SIDECAR_ENV];
  if (envPath !== undefined && envPath.length > 0) {
    return envPath;
  }

  const defaultPath = sidecarBinaryPath();
  try {
    await stat(defaultPath);
    return defaultPath;
  } catch {
    // Build a native sidecar for the current host so tests can exercise it.
    const rustDir = join(import.meta.dir, "..", "rust");
    const result = await $`cd ${rustDir} && cargo build --release`.quiet();
    if (result.exitCode !== 0) {
      throw new Error(`Failed to build local-custody sidecar for tests: ${result.stderr.toString()}`);
    }
    // The cargo workspace lives at the repository root, so `target/` resolves
    // one level above the `rust/` member directory.
    const nativePath = join(rustDir, "..", "target", "release", "local-custody");
    await stat(nativePath);
    return nativePath;
  }
}

describe("custody-rust loader", () => {
  const originalEnv = process.env[SIDECAR_ENV];
  const tempDirectories: string[] = [];
  let engine: LocalCustodyRustEngine;

  beforeAll(async () => {
    process.env[SIDECAR_ENV] = await ensureSidecarPath();
    engine = await loadLocalCustodyRustEngine();
  }, 120000);

  afterAll(async () => {
    if (originalEnv === undefined) {
      delete process.env[SIDECAR_ENV];
    } else {
      process.env[SIDECAR_ENV] = originalEnv;
    }
    for (const dir of tempDirectories) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Cleanup is best-effort; tests already completed.
      }
    }
  });

  async function makeTempDir(): Promise<string> {
    // The sidecar requires canonical private paths; canonicalize tmpdir so a
    // symlinked /var root cannot push tests onto the TypeScript path.
    const dir = await mkdtemp(join(realpathSync(tmpdir()), "local-custody-rust-test-"));
    tempDirectories.push(dir);
    return dir;
  }

  test("sidecarBinaryPath resolves default host artifact path", () => {
    const realPath = process.env[SIDECAR_ENV];
    delete process.env[SIDECAR_ENV];
    try {
      const path = sidecarBinaryPath("darwin", "arm64");
      expect(path).toContain("rust-artifacts/local-custody/darwin-arm64/local-custody");
    } finally {
      if (realPath !== undefined) {
        process.env[SIDECAR_ENV] = realPath;
      }
    }
  });

  test("loads the rust-sidecar implementation when the binary is staged", () => {
    expect(engine.implementation).toBe("rust-sidecar");
  });

  test("ensurePrivateDirectory creates a private directory", async () => {
    const root = await makeTempDir();
    const path = join(root, "private");
    const resolved = await engine.ensurePrivateDirectory(path);
    expect(resolved).toBe(path);
    expect((await stat(resolved)).isDirectory()).toBe(true);
  });

  test("assertOwnedPath validates an owned file", async () => {
    const root = await makeTempDir();
    const target = join(root, "state.json");
    await writeFile(target, "x");
    chmodSync(target, 0o600);
    const identity = await engine.assertOwnedPath(target, { kind: "file", exactMode: 0o600 });
    expect(identity.size).toBe(1);
    expect(Number.isSafeInteger(identity.dev)).toBe(true);
    expect(Number.isSafeInteger(identity.ino)).toBe(true);
  });

  test("assertOwnedPath surfaces the domain failure envelope", async () => {
    const root = await makeTempDir();
    const target = join(root, "open.json");
    await writeFile(target, "x");
    chmodSync(target, 0o640);
    try {
      await engine.assertOwnedPath(target, { kind: "file", exactMode: 0o600 });
      expect.unreachable("mode mismatch must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CustodyError);
      expect((error as CustodyError).code).toBe("mode-mismatch");
    }
  });

  test("assertOwnedPath on a missing path reports the stat code", async () => {
    const root = await makeTempDir();
    try {
      await engine.assertOwnedPath(join(root, "missing"), { kind: "file" });
      expect.unreachable("missing path must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CustodyError);
      expect((error as CustodyError).code).toBe("stat");
    }
  });

  test("readOwnedFileStable returns bytes with identity", async () => {
    const root = await makeTempDir();
    const target = join(root, "capability.bin");
    await writeFile(target, "capability-bytes");
    chmodSync(target, 0o600);
    const read = await engine.readOwnedFileStable(target, 1024);
    expect(read.bytes.toString("utf8")).toBe("capability-bytes");
    expect(Number.isSafeInteger(read.dev)).toBe(true);
    expect(Number.isSafeInteger(read.ino)).toBe(true);
  });

  test("publishPrivateFile and createPrivateFileOnce round trip", async () => {
    const root = await makeTempDir();
    await engine.ensurePrivateDirectory(root);
    await engine.publishPrivateFile(root, "first.txt", "one");
    expect(await engine.readOwnedFileStable(join(root, "first.txt"), 64))
      .toMatchObject({ bytes: Buffer.from("one") });

    expect(await engine.createPrivateFileOnce(root, "once.txt", "alpha")).toBe("created");
    expect(await engine.createPrivateFileOnce(root, "once.txt", "beta")).toBe("existing");
    expect(await engine.readOwnedFileStable(join(root, "once.txt"), 64))
      .toMatchObject({ bytes: Buffer.from("alpha") });
  });

  test("readProtectedDescriptor reads a regular file through the sidecar", async () => {
    const root = await makeTempDir();
    const target = join(root, "secret.txt");
    const writeFd = openSync(target, "w", 0o600);
    writeSync(writeFd, "token-value");
    closeSync(writeFd);
    const readFd = openSync(target, "r");
    try {
      expect(await engine.readProtectedDescriptor(readFd)).toBe("token-value");
    } finally {
      closeSync(readFd);
    }
  });

  test("requestControlSocket round trips through a TypeScript listener", async () => {
    const root = await makeTempDir();
    await engine.ensurePrivateDirectory(root);
    const server = await engine.listenControlSocket({
      socketPath: join(root, "control.sock"),
      maximumFrameBytes: 1024,
      failureResponse: (reason) => ({ ok: false, code: reason }),
      onRequest: (request) => ({ ok: true, echo: request }),
    });
    try {
      const response = await engine.requestControlSocket({
        socketPath: server.socketPath,
        request: { ping: 1 },
        maximumResponseBytes: 1024,
        timeoutMs: 5000,
        parseResponse: (value) => value,
      });
      expect(response).toEqual({ ok: true, echo: { ping: 1 } });
    } finally {
      await server.close();
    }
  });

  test("control failure envelopes without a message pass through", async () => {
    const root = await makeTempDir();
    await engine.ensurePrivateDirectory(root);
    const server = await engine.listenControlSocket({
      socketPath: join(root, "control.sock"),
      maximumFrameBytes: 1024,
      failureResponse: (reason) => ({ ok: false, code: reason }),
      onRequest: () => ({ ok: false, code: "product-limit" }),
    });
    try {
      const response = await engine.requestControlSocket({
        socketPath: server.socketPath,
        request: { ping: 2 },
        maximumResponseBytes: 1024,
        timeoutMs: 5000,
        parseResponse: (value) => value,
      });
      // The socket's own failure envelope is not a sidecar failure.
      expect(response).toEqual({ ok: false, code: "product-limit" });
    } finally {
      await server.close();
    }
  });

  test("directory assertions without a link bound stay on TypeScript with a notice", async () => {
    const root = await makeTempDir();
    await engine.ensurePrivateDirectory(root);
    const write = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const identity = await engine.assertOwnedPath(root, { kind: "directory", canonical: true });
      expect(Number.isSafeInteger(identity.dev)).toBe(true);
      const lines = write.mock.calls.map((call) => String(call[0]));
      expect(lines).toContain("[local-custody-rust-fallback] unsupported-input input=owned-path-shape\n");
    } finally {
      write.mockRestore();
    }
  });

  test("a missing binary falls back to the TypeScript implementation", async () => {
    const root = await makeTempDir();
    const realPath = process.env[SIDECAR_ENV];
    process.env[SIDECAR_ENV] = join(root, "no-such-binary");
    try {
      const fallback = await loadLocalCustodyRustEngine();
      expect(fallback.implementation).toBe("typescript");
      const path = join(root, "private");
      expect(await fallback.ensurePrivateDirectory(path)).toBe(path);
    } finally {
      if (realPath === undefined) {
        delete process.env[SIDECAR_ENV];
      } else {
        process.env[SIDECAR_ENV] = realPath;
      }
    }
  });
});
