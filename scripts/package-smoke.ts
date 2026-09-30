import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
const arguments_ = process.argv.slice(2);
let exactArchive: string | undefined;
let requireRust = false;
while (arguments_.length > 0) {
  const argument = arguments_.shift();
  if (argument === "--archive" && exactArchive === undefined && arguments_[0] !== undefined) {
    exactArchive = resolve(arguments_.shift()!);
  } else if (argument === "--require-rust" && !requireRust) {
    requireRust = true;
  } else {
    throw new Error("Usage: package-smoke.ts [--archive PATH] [--require-rust]");
  }
}
if (requireRust && exactArchive === undefined) throw new Error("Native release smoke requires an exact archive");
const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
const work = await mkdtemp(join(temporaryRoot, "hraness-local-custody-smoke-"));

async function run(command: string[], cwd: string): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: work };
  delete environment.HRANESS_LOCAL_CUSTODY_CLI_PATH;
  const child = Bun.spawn(command, {
    cwd,
    env: environment,
    timeout: 120_000,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [output, diagnostics, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (requireRust && diagnostics.includes("[local-custody-rust-fallback]")) {
    throw new Error("Native packed smoke used the TypeScript fallback");
  }
  if (exitCode !== 0) {
    throw new Error(`Command failed (${String(exitCode)}): ${command.join(" ")}\n${output}\n${diagnostics}`);
  }
  return output;
}

try {
  let archive = exactArchive;
  if (archive === undefined) {
    const pack = await run(["npm", "pack", "--ignore-scripts", "--pack-destination", work], repository);
    archive = join(work, pack.trim().split("\n").at(-1)!);
  }
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 128 * 1024 * 1024) {
    throw new Error("Package smoke needs one bounded regular npm tarball");
  }
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
  // One class identity per error type across every subpath: an error thrown
  // through one entrypoint passes `instanceof` against the class from another.
  await run([
    "node", "--input-type=module", "-e",
    `import assert from "node:assert/strict";
import * as root from "${packageName}";
import * as socket from "${packageName}/control-socket";
import * as input from "${packageName}/protected-input";
import * as rust from "${packageName}/custody-rust";
assert.equal(root.ControlSocketError, socket.ControlSocketError);
assert.equal(root.ProtectedInputError, input.ProtectedInputError);
const refused = new rust.CustodyError("mode", "detail");
assert.ok(refused instanceof rust.CustodyError);
try { await root.requestControlSocket({ socketPath: "/nonexistent/lc.sock", request: {}, maximumResponseBytes: 64, timeoutMs: 1000, parseResponse: (v) => v }); assert.fail("expected a refusal"); }
catch (error) { assert.ok(error instanceof socket.ControlSocketError, String(error)); }
console.log("error identity across subpaths passed");`,
  ], consumer);
  // Exercise the packed runtime end to end under Node: private directory,
  // atomic publication, and a live control-socket round trip.
  await run([
    "node", "--input-type=module", "-e",
    `import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  if (requireRust) {
    await run([
      "node", "--input-type=module", "-e",
      `import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLocalCustodyRustEngine } from "${packageName}/custody-rust";
assert.equal(process.platform, "darwin");
const engine = await loadLocalCustodyRustEngine();
assert.equal(engine.implementation, "rust-sidecar", "signed packaged sidecar must load");
const directory = await engine.ensurePrivateDirectory(await mkdtemp(join(tmpdir(), "lc-native-smoke-")));
await engine.publishPrivateFile(directory, "proof.txt", "signed-native-round-trip");
assert.equal(await readFile(join(directory, "proof.txt"), "utf8"), "signed-native-round-trip");
console.log("Exact signed native package round trip passed");`,
    ], consumer);
  }
  console.log("Package smoke passed for", importSpecifiers.length, "entrypoints.");
} finally {
  await rm(work, { force: true, recursive: true });
}
