import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { publishPrivateFile } from "./atomic-publish.ts";
import { ensurePrivateDirectory } from "./private-paths.ts";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "local-custody-publish-"));
  roots.push(path);
  return ensurePrivateDirectory(path);
};
afterEach(async () => {
  while (roots.length > 0) {
    const path = roots.pop()!;
    await chmod(path, 0o700).catch(() => undefined);
    await rm(path, { force: true, recursive: true });
  }
});

describe("publishPrivateFile", () => {
  test("publishes a mode-0600 single-link file with exact content", async () => {
    const dir = await root();
    await publishPrivateFile(dir, "capability", "token-value\n");
    const path = join(dir, "capability");
    const metadata = await lstat(path);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(Number(metadata.nlink)).toBe(1);
    assert.equal(await readFile(path, "utf8"), "token-value\n");
  });

  test("atomically replaces an existing target", async () => {
    const dir = await root();
    await publishPrivateFile(dir, "capability", "first");
    await publishPrivateFile(dir, "capability", "second");
    assert.equal(await readFile(join(dir, "capability"), "utf8"), "second");
  });

  test("rejects unsafe names", async () => {
    const dir = await root();
    for (const name of ["../escape", "a/b", "", ".hidden", "..", "a b", "a\nb"]) {
      await assert.rejects(publishPrivateFile(dir, name, "x"));
    }
    assert.equal((await readdir(dir)).filter(n => !n.startsWith(".")).length, 0);
  });

  test("leaves no temporary file after failure", async () => {
    const dir = await root();
    await assert.rejects(publishPrivateFile(join(dir, "missing", "deep"), "name", "x"));
    assert.deepEqual((await readdir(dir)).filter(n => n.endsWith(".tmp")), []);
  });
});
