import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { openSync, closeSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { readProtectedDescriptor } from "./protected-input.ts";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "local-custody-input-"));
  roots.push(path);
  return path;
};
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

const withDescriptor = (path: string, run: (fd: number) => void): void => {
  const fd = openSync(path, "r");
  try { run(fd); } finally { closeSync(fd); }
};

describe("readProtectedDescriptor", () => {
  test("reads a private file end to end", async () => {
    const dir = await root();
    const file = join(dir, "handoff.json");
    await writeFile(file, "{\"token\":\"abc\"}\n", { mode: 0o600 });
    withDescriptor(file, (fd) => {
      assert.equal(readProtectedDescriptor(fd), "{\"token\":\"abc\"}\n");
    });
  });

  test("rejects a permissive file", async () => {
    const dir = await root();
    const file = join(dir, "open");
    await writeFile(file, "secret", { mode: 0o644 });
    withDescriptor(file, (fd) => {
      expect(() => readProtectedDescriptor(fd)).toThrow("owned and private");
    });
  });

  test("reads a fifo descriptor", async () => {
    const dir = await root();
    const fifo = join(dir, "pipe");
    const made = spawnSync("mkfifo", [fifo]);
    assert.equal(made.status, 0);
    // A writer that exits closes its end; the reader then sees EOF.
    const writer = spawn("sh", ["-c", `printf 'from-a-pipe' > "$1"`, "sh", fifo], {
      stdio: "ignore",
    });
    const fd = openSync(fifo, "r");
    try {
      assert.equal(readProtectedDescriptor(fd), "from-a-pipe");
    } finally { closeSync(fd); }
    await new Promise<void>((resolve) => writer.once("exit", () => resolve()));
  });

  test("enforces the byte bound", async () => {
    const dir = await root();
    const file = join(dir, "big");
    await writeFile(file, "x".repeat(128), { mode: 0o600 });
    withDescriptor(file, (fd) => {
      expect(() => readProtectedDescriptor(fd, { maximumBytes: 64 })).toThrow("size bound");
    });
  });

  test("rejects invalid descriptors and bounds", () => {
    expect(() => readProtectedDescriptor(-1)).toThrow("valid descriptor");
    expect(() => readProtectedDescriptor(0, { maximumBytes: 0 })).toThrow("positive integer");
  });
});
