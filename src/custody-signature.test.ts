import { expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import type * as Custody from "./custody-rust";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test.skipIf(process.platform !== "darwin")("untrusted default helper never executes and uses the safe TypeScript engine", async () => {
  const root = await mkdtemp("/private/tmp/lc-signature-integration-");
  const prior = process.env.HRANESS_LOCAL_CUSTODY_CLI_PATH;
  try {
    await mkdir(join(root, "src"));
    for (const name of await readdir(import.meta.dir)) {
      if (name.endsWith(".ts") && !name.includes(".test.")) await cp(join(import.meta.dir, name), join(root, "src", name));
    }
    const folder = join(root, "dist/rust-artifacts/local-custody", `darwin-${process.arch}`);
    await mkdir(folder, { recursive: true });
    const marker = join(root, "executed");
    await writeFile(join(folder, "local-custody"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    delete process.env.HRANESS_LOCAL_CUSTODY_CLI_PATH;
    const custody = await import(pathToFileURL(join(root, "src/custody-rust.ts")).href) as typeof Custody;
    const untrusted = await custody.loadLocalCustodyRustEngine();
    expect(untrusted.implementation).toBe("typescript");
    await untrusted.ensurePrivateDirectory(join(root, "private"));
    expect(await stat(marker).catch(() => null)).toBeNull();

    // The load check alone cannot authorize a later changed or untrusted file.
    const verifier = spyOn(childProcess, "execFile").mockImplementation(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(null);
      return new childProcess.ChildProcess();
    }) as typeof childProcess.execFile);
    let loaded: Awaited<ReturnType<typeof custody.loadLocalCustodyRustEngine>>;
    try { loaded = await custody.loadLocalCustodyRustEngine(); }
    finally { verifier.mockRestore(); }
    expect(loaded.implementation).toBe("rust-sidecar");
    await loaded.ensurePrivateDirectory(join(root, "private-after-load"));
    expect(await stat(marker).catch(() => null)).toBeNull();
  } finally {
    if (prior === undefined) delete process.env.HRANESS_LOCAL_CUSTODY_CLI_PATH;
    else process.env.HRANESS_LOCAL_CUSTODY_CLI_PATH = prior;
    await rm(root, { recursive: true, force: true });
  }
});
