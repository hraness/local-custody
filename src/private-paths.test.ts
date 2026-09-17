import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertOwnedPath,
  ensurePrivateDirectory,
  readPrivateFile,
} from "./private-paths.ts";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "local-custody-paths-"));
  roots.push(path);
  return path;
};
afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { force: true, recursive: true });
  }
});

describe("ensurePrivateDirectory", () => {
  test("creates an owned mode-0700 directory and returns the resolved path", async () => {
    const base = await root();
    const created = await ensurePrivateDirectory(join(base, "state"));
    const metadata = await import("node:fs/promises").then((fs) => fs.lstat(created));
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.mode & 0o777).toBe(0o700);
    expect(created).toBe(join(base, "state"));
  });

  test("is idempotent on an existing private directory", async () => {
    const base = await root();
    await ensurePrivateDirectory(join(base, "state"));
    await ensurePrivateDirectory(join(base, "state"));
  });

  test("rejects a permissive existing directory", async () => {
    const base = await root();
    const target = join(base, "open");
    await mkdir(target, { mode: 0o755 });
    await assert.rejects(ensurePrivateDirectory(target), /private/);
  });

  test("rejects a symlinked directory", async () => {
    const base = await root();
    const real = join(base, "real");
    await mkdir(real, { mode: 0o700 });
    const link = join(base, "link");
    await symlink(real, link);
    await assert.rejects(ensurePrivateDirectory(link));
  });
});

describe("assertOwnedPath", () => {
  test("accepts a private file within bounds", async () => {
    const base = await root();
    const file = join(base, "secret");
    await writeFile(file, "value", { mode: 0o600 });
    await assertOwnedPath(file, {
      kind: "file", exactMode: 0o600, maximumBytes: 16n,
    });
  });

  test("rejects group/other permission bits", async () => {
    const base = await root();
    const file = join(base, "leaky");
    await writeFile(file, "value", { mode: 0o644 });
    await assert.rejects(
      assertOwnedPath(file, { kind: "file", exactMode: 0o600 }),
      /Unsafe local file/,
    );
  });

  test("rejects a symlink", async () => {
    const base = await root();
    const file = join(base, "real");
    await writeFile(file, "value", { mode: 0o600 });
    const link = join(base, "link");
    await symlink(file, link);
    await assert.rejects(assertOwnedPath(link, { kind: "file" }));
  });

  test("rejects extra hard links", async () => {
    const base = await root();
    const file = join(base, "secret");
    await writeFile(file, "value", { mode: 0o600 });
    await import("node:fs/promises").then((fs) => fs.link(file, join(base, "alias")));
    await assert.rejects(assertOwnedPath(file, { kind: "file" }));
  });

  test("rejects wrong kind", async () => {
    const base = await root();
    const file = join(base, "not-a-socket");
    await writeFile(file, "value", { mode: 0o600 });
    await assert.rejects(assertOwnedPath(file, { kind: "socket" }));
  });
});

describe("readPrivateFile", () => {
  test("reads a private file completely", async () => {
    const base = await root();
    const file = join(base, "settings.json");
    await writeFile(file, "{\"a\":1}", { mode: 0o600 });
    assert.equal((await readPrivateFile(file, 64)).toString("utf8"), "{\"a\":1}");
  });

  test("rejects oversized files", async () => {
    const base = await root();
    const file = join(base, "big");
    await writeFile(file, "x".repeat(200), { mode: 0o600 });
    await assert.rejects(readPrivateFile(file, 64));
  });

  test("rejects a permissive file", async () => {
    const base = await root();
    const file = join(base, "open");
    await writeFile(file, "v", { mode: 0o640 });
    await assert.rejects(readPrivateFile(file, 64));
  });

  test("rejects a symlink even to a private target", async () => {
    const base = await root();
    const file = join(base, "real");
    await writeFile(file, "v", { mode: 0o600 });
    const link = join(base, "link");
    await symlink(file, link);
    await assert.rejects(readPrivateFile(link, 64));
  });
});
