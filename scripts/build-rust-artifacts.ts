import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { buildLocalCustodyArtifactManifest } from "./build-rust-manifest";

function hostPlatformArch(): { platform: string; arch: string; triple: string } {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") {
    return { platform: "darwin", arch: "arm64", triple: "aarch64-apple-darwin" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { platform: "darwin", arch: "x64", triple: "x86_64-apple-darwin" };
  }
  if (platform === "linux" && arch === "x64") {
    return { platform: "linux", arch: "x64", triple: "x86_64-unknown-linux-gnu" };
  }
  throw new Error(`Unsupported host platform for sidecar build: ${platform}-${arch}`);
}

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist", "rust-artifacts");

// Ensure rustup-managed toolchains take precedence over any system/Homebrew
// Rust installation that may lack the requested target.
const cargoBin = `${process.env.HOME ?? ""}/.cargo/bin`;
process.env.PATH = `${cargoBin}:${process.env.PATH ?? ""}`;
process.env.RUSTFLAGS = `${process.env.RUSTFLAGS ?? ""} --remap-path-prefix=${root}=. --remap-path-prefix=${process.env.HOME ?? ""}/.cargo/registry/src/=/cargo-registry-src/ --remap-path-prefix=${process.env.HOME ?? ""}/.rustup/toolchains/=/rust-toolchains/ -C strip=symbols`.trim();

const CRATE = "local-custody";

async function copyCargoNative() {
  const { platform, arch, triple } = hostPlatformArch();
  const source = resolve(root, "target", triple, "release", CRATE);
  const target = resolve(outDir, CRATE, `${platform}-${arch}`);
  await mkdir(target, { recursive: true });
  const dest = resolve(target, CRATE);
  await writeFile(dest, await readFile(source));
  await chmod(dest, 0o755);
  try {
    execFileSync("strip", [dest]);
  } catch {
    // Stripping is best-effort; some hosts may not have a compatible strip for the target.
  }
  const finalBytes = await readFile(dest);
  const sha = createHash("sha256").update(finalBytes).digest("hex");
  const manifestPath = resolve(target, "artifact.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      crate: CRATE,
      platform,
      arch,
      triple,
      sha256: sha,
      bytes: finalBytes.length,
    }, null, 2) + "\n",
  );
}

async function build() {
  const { triple } = hostPlatformArch();
  const result = await $`cd ${resolve(root, "rust")} && cargo build --release --target ${triple} -p ${CRATE}`.quiet();
  if (result.exitCode !== 0) {
    throw new Error(`cargo build failed for ${CRATE} (${triple}): ${result.stderr.toString()}`);
  }
  await copyCargoNative();
}

await build();
await buildLocalCustodyArtifactManifest();
