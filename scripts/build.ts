import { rm } from "node:fs/promises";

const entrypoints = [
  "src/index.ts",
  "src/atomic-publish.ts",
  "src/control-socket.ts",
  "src/private-paths.ts",
  "src/protected-input.ts",
  "src/custody-rust.ts",
  "src/rust-fallback.ts",
  "src/artifact-manifest.ts",
];

await rm("dist", { force: true, recursive: true });
const result = await Bun.build({
  entrypoints,
  format: "esm",
  outdir: "dist",
  target: "node",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Package build failed.");
}
