import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const repository = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "local-custody-determinism-"));
async function inventory(root: string, directory = root): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await inventory(root, path));
    else {
      assert.ok(entry.isFile(), "Generated output must contain only regular files.");
      result[relative(root, path)] = createHash("sha256").update(await readFile(path)).digest("hex");
    }
  }
  return result;
}
try {
  const expected = await inventory(join(repository, "dist"));
  for (const label of ["short", "unrelated/deep/absolute-root"]) {
    const root = join(temporary, label);
    await mkdir(root, { recursive: true });
    for (const path of ["src", "scripts", "package.json"]) {
      await cp(join(repository, path), join(root, path), { recursive: true });
    }
    await symlink(join(repository, "node_modules"), join(root, "node_modules"), "dir");
    const build = Bun.spawn([process.execPath, "run", "./scripts/build.ts"], {
      cwd: root, env: { ...process.env, NODE_ENV: "production" }, stderr: "inherit", stdout: "inherit",
    });
    assert.equal(await build.exited, 0, "Isolated deterministic build failed.");
    assert.deepEqual(await inventory(join(root, "dist")), expected, "Generated artifact hashes changed with the absolute root.");
  }
  console.log(`Verified ${Object.keys(expected).length} package artifacts across two isolated absolute roots.`);
} finally {
  await rm(temporary, { force: true, recursive: true });
}
