import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const repositoryRoot = new URL("../", import.meta.url);
const readme = readFileSync(new URL("README.md", repositoryRoot), "utf8");
const manifest = JSON.parse(readFileSync(new URL("package.json", repositoryRoot), "utf8")) as {
  readonly name: string;
  readonly version: string;
  readonly exports: Readonly<Record<string, unknown>>;
};

describe("README facts", () => {
  test("installs the published npm package, not a stale Git tag", () => {
    expect(readme).toContain(`bun add ${manifest.name}\n`);
    for (const match of readme.matchAll(/github:hraness\/local-custody#v(\d+\.\d+\.\d+)/gu)) {
      expect(match[1], "README pins a Git tag that is not the package version").toBe(manifest.version);
    }
  });

  test("lists every exported subpath", () => {
    for (const subpath of Object.keys(manifest.exports)) {
      if (subpath === "." || subpath === "./package.json") continue;
      expect(readme, `README entrypoint table is missing ${subpath}`).toContain(`| \`${subpath.slice(1)}\` |`);
    }
  });

  test("uses no em dashes", () => {
    expect(readme).not.toContain("—");
  });
});
