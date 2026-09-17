import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listenControlSocket,
  requestControlSocket,
  type ControlSocketServer,
} from "./control-socket.ts";
import { ensurePrivateDirectory } from "./private-paths.ts";

const roots: string[] = [];
const servers: ControlSocketServer[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "local-custody-socket-"));
  roots.push(path);
  return ensurePrivateDirectory(path);
};
const listen = async (
  options: Parameters<typeof listenControlSocket>[0],
): Promise<ControlSocketServer> => {
  const server = await listenControlSocket(options);
  servers.push(server);
  return server;
};
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

const echo = {
  failureResponse: { ok: false, code: "failed" },
  onRequest: (request: unknown) => ({ ok: true, echo: request }),
};

describe("listenControlSocket", () => {
  test("serves a bounded request and validates the published socket", async () => {
    const dir = await root();
    const server = await listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024, ...echo,
    });
    const metadata = await lstat(server.socketPath);
    expect(metadata.isSocket()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o600);
    const response = await requestControlSocket({
      socketPath: server.socketPath,
      request: { ping: 1 },
      maximumResponseBytes: 1_024,
      timeoutMs: 5_000,
      parseResponse: (value) => value as { ok: boolean },
    });
    assert.deepEqual(response, { ok: true, echo: { ping: 1 } });
  });

  test("removes an owned stale socket before binding", async () => {
    const dir = await root();
    const first = await listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024, ...echo,
    });
    await first.close();
    await listen({ socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024, ...echo });
  });

  test("refuses a non-socket occupant at the socket path", async () => {
    const dir = await root();
    await writeFile(join(dir, "c.sock"), "not a socket", { mode: 0o600 });
    await assert.rejects(listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024, ...echo,
    }));
  });

  test("refuses a socket path outside a private directory", async () => {
    const dir = await root();
    const open = join(dir, "open");
    await import("node:fs/promises").then((fs) => fs.mkdir(open, { mode: 0o755 }));
    await assert.rejects(listen({
      socketPath: join(open, "c.sock"), maximumFrameBytes: 1_024, ...echo,
    }));
  });

  test("rejects a socket path beyond the platform limit", async () => {
    const dir = await root();
    await assert.rejects(listen({
      socketPath: join(dir, "x".repeat(200)), maximumFrameBytes: 1_024, ...echo,
    }), /platform limit/);
  });
});

describe("requestControlSocket", () => {
  test("writes the failure response for unparsable frames", async () => {
    const dir = await root();
    const server = await listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024, ...echo,
    });
    const response = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(server.socketPath);
      socket.once("connect", () => socket.write("not-json\n"));
      socket.on("data", resolve);
      socket.once("error", reject);
    });
    assert.deepEqual(JSON.parse(response.toString("utf8").trim()), { ok: false, code: "failed" });
  });

  test("destroys connections that exceed the request bound", async () => {
    const dir = await root();
    const server = await listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 64, ...echo,
    });
    const oversized = `${"x".repeat(128)}\n`;
    await new Promise<void>((resolve, reject) => {
      const socket = connect(server.socketPath);
      socket.once("connect", () => socket.write(oversized));
      socket.once("close", () => resolve());
      socket.once("error", () => resolve());
      setTimeout(() => reject(new Error("connection survived oversize frame")), 5_000);
    });
  });

  test("serves pipelined requests up to the per-connection bound", async () => {
    const dir = await root();
    const server = await listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024,
      maximumRequestsPerConnection: 2, ...echo,
    });
    const responses = await new Promise<Buffer[]>((resolve, reject) => {
      const socket = connect(server.socketPath);
      const collected: Buffer[] = [];
      let buffer = Buffer.alloc(0);
      socket.once("connect", () => socket.write('{"n":1}\n{"n":2}\n'));
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const newline = buffer.indexOf(0x0a);
          if (newline < 0) return;
          collected.push(buffer.subarray(0, newline));
          buffer = buffer.subarray(newline + 1);
          if (collected.length === 2) resolve(collected);
        }
      });
      socket.once("error", reject);
      setTimeout(() => reject(new Error("pipelined responses never arrived")), 5_000);
    });
    assert.deepEqual(
      responses.map((line) => JSON.parse(line.toString("utf8")) as unknown),
      [{ ok: true, echo: { n: 1 } }, { ok: true, echo: { n: 2 } }],
    );
  });

  test("client times out against a slow handler", async () => {
    const dir = await root();
    const server = await listen({
      socketPath: join(dir, "c.sock"), maximumFrameBytes: 1_024,
      failureResponse: { ok: false },
      onRequest: () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 2_000)),
    });
    await assert.rejects(requestControlSocket({
      socketPath: server.socketPath,
      request: { ping: 1 },
      maximumResponseBytes: 1_024,
      timeoutMs: 200,
      parseResponse: (value) => value,
    }), /timed out/);
  });

  test("rejects requests to a missing socket", async () => {
    const dir = await root();
    await assert.rejects(requestControlSocket({
      socketPath: join(dir, "absent.sock"),
      request: {},
      maximumResponseBytes: 1_024,
      timeoutMs: 1_000,
      parseResponse: (value) => value,
    }));
  });

  test("server close removes its own socket", async () => {
    const dir = await root();
    const path = join(dir, "c.sock");
    const server = await listenControlSocket({
      socketPath: path, maximumFrameBytes: 1_024, ...echo,
    });
    await server.close();
    await assert.rejects(
      lstat(path),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});
