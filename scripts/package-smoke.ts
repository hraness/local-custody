import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageName = "@hraness/local-custody";
const importSpecifiers = [
  packageName,
  `${packageName}/atomic-publish`,
  `${packageName}/control-socket`,
  `${packageName}/private-paths`,
  `${packageName}/protected-input`,
  `${packageName}/custody-rust`,
  `${packageName}/rust-fallback`,
  `${packageName}/artifact-manifest`,
] as const;
const repository = process.cwd();
const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const work = await mkdtemp(join(temporaryRoot, "hraness-local-custody-smoke-"));

async function run(command: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, TMPDIR: work },
    stderr: "inherit",
    stdout: "pipe",
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}\n${output}`);
  }
  return output;
}

try {
  const pack = await run(["npm", "pack", "--ignore-scripts", "--pack-destination", work], repository);
  const archive = join(work, pack.trim().split("\n").at(-1)!);
  const consumer = join(work, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      dependencies: { [packageName]: archive },
      private: true,
      type: "module",
    }),
  );
  await run([process.execPath, "install", "--ignore-scripts"], consumer);
  await run([
    "node", "--input-type=module", "-e",
    `await Promise.all(${JSON.stringify(importSpecifiers)}.map((specifier) => import(specifier)))`,
  ], consumer);
  // Exercise the packed runtime end to end under Node: private directory,
  // atomic publication, and a live control-socket round trip.
  await run([
    "node", "--input-type=module", "-e",
    `import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePrivateDirectory, publishPrivateFile, listenControlSocket, requestControlSocket } from "${packageName}";
const root = await ensurePrivateDirectory(mkdtempSync(join(tmpdir(), "lc-smoke-")));
await publishPrivateFile(root, "capability.txt", "synthetic-capability");
const stat = await lstat(join(root, "capability.txt"));
assert.equal(stat.mode & 0o777, 0o600);
const server = await listenControlSocket({ socketPath: join(root, "c.sock"), maximumFrameBytes: 1024, failureResponse: { ok: false }, onRequest: (r) => ({ ok: true, echo: r }) });
const response = await requestControlSocket({ socketPath: server.socketPath, request: { ping: 1 }, maximumResponseBytes: 1024, timeoutMs: 5000, parseResponse: (v) => v });
assert.deepEqual(response, { ok: true, echo: { ping: 1 } });
await server.close();
console.log("packed consumer round trip passed");`,
  ], consumer);
  console.log("Package smoke passed for", importSpecifiers.length, "entrypoints.");
} finally {
  await rm(work, { force: true, recursive: true });
}
