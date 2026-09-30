import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

for (const suite of ["test_sign_macos_sidecars.py", "test_release_workflow.py"]) {
  test(`release boundary: ${suite}`, () => {
    const result = spawnSync("python3", ["-B", resolve(import.meta.dir, "..", "scripts", suite)], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 256 * 1024,
    });
    if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "Python release tests failed");
    expect(result.status).toBe(0);
  }, 25_000);
}
