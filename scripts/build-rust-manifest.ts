import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

/**
 * Generate `dist/rust-artifacts/manifest.json`, the compatibility manifest
 * consumed by `@hraness/local-custody/artifact-manifest`. Run after the
 * artifacts have been built (and, in the release workflow, after every
 * native sidecar has been staged) so the manifest digests describe the exact
 * shipped bytes.
 */

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist", "rust-artifacts");

const SIDECAR_CONTRACT = {
  crate: "local-custody",
  engine: "local-custody.rust.v1",
  abi: "local-custody-sidecar-abi.v1",
  kind: "cargo-native",
  maxInputBytes: null,
} as const;

async function listFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir);
  const files: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if ((await stat(path)).isFile()) files.push(relative(outDir, path).split("\\").join("/"));
  }
  return files.sort();
}

async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await readFile(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}

export async function buildLocalCustodyArtifactManifest(): Promise<number> {
  const artifacts: Record<string, unknown>[] = [];

  const sidecarRoot = resolve(outDir, SIDECAR_CONTRACT.crate);
  const targets = (await readdir(sidecarRoot).catch(() => [] as string[])).sort();
  for (const target of targets) {
    const primary = `${SIDECAR_CONTRACT.crate}/${target}/${SIDECAR_CONTRACT.crate}`;
    const primaryPath = resolve(outDir, primary);
    if (!(await stat(primaryPath).catch(() => null))?.isFile()) continue;
    const { sha256, bytes } = await hashFile(primaryPath);
    const files = await listFiles(resolve(sidecarRoot, target));
    artifacts.push({
      engine: SIDECAR_CONTRACT.engine,
      abi: SIDECAR_CONTRACT.abi,
      crate: SIDECAR_CONTRACT.crate,
      kind: SIDECAR_CONTRACT.kind,
      target,
      files,
      primary,
      sha256,
      bytes,
      maxInputBytes: SIDECAR_CONTRACT.maxInputBytes,
    });
  }

  const manifest = JSON.stringify({ version: 1, artifacts }, null, 2) + "\n";
  await writeFile(resolve(outDir, "manifest.json"), manifest);
  return artifacts.length;
}

if (import.meta.main) {
  const count = await buildLocalCustodyArtifactManifest();
  console.log(`Wrote rust artifact manifest with ${count} entries.`);
}
