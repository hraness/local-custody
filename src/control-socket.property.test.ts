import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { mkdtemp, rm } from "node:fs/promises";
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
afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

const jsonValue = fc.jsonValue({ maxDepth: 3 });

describe("control socket round trip", () => {
  test("arbitrary JSON values survive the frame boundary unchanged", async () => {
    const dir = ensurePrivateDirectory(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "local-custody-prop-")));
    roots.push(await dir);
    const server = await listenControlSocket({
      socketPath: join(await dir, "c.sock"),
      maximumFrameBytes: 65_536,
      failureResponse: { ok: false },
      onRequest: (request) => ({ ok: true, echo: request }),
    });
    servers.push(server);
    await fc.assert(
      fc.asyncProperty(jsonValue, async (value) => {
        // JSON.stringify normalizes NaN/Infinity to null; the wire law is
        // equality after one JSON round trip, not object identity.
        const expected: unknown = JSON.parse(JSON.stringify(value));
        const response = await requestControlSocket({
          socketPath: server.socketPath,
          request: value,
          maximumResponseBytes: 65_536,
          timeoutMs: 5_000,
          parseResponse: (parsed) => parsed as { ok: boolean; echo: unknown },
        });
        assert.deepEqual(response, { ok: true, echo: expected });
      }),
      { numRuns: 40 },
    );
  });

  test("response larger than the client bound fails instead of truncating", async () => {
    const dir = await ensurePrivateDirectory(await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "local-custody-prop-")));
    roots.push(dir);
    const server = await listenControlSocket({
      socketPath: join(dir, "c.sock"),
      maximumFrameBytes: 65_536,
      failureResponse: { ok: false },
      onRequest: () => ({ pad: "x".repeat(4_096) }),
    });
    servers.push(server);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 16, max: 4_096 }), async (bound) => {
        await assert.rejects(requestControlSocket({
          socketPath: server.socketPath,
          request: { ping: 1 },
          maximumResponseBytes: bound,
          timeoutMs: 5_000,
          parseResponse: (parsed) => parsed,
        }));
      }),
      { numRuns: 20 },
    );
  });
});
