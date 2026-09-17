import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

type DependencyScope = "development" | "optional" | "peer" | "runtime";

const root = resolve(import.meta.dir, "..");

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const packageJson = asObject(
  JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as unknown,
  "package.json",
);
const packageName = requiredString(packageJson, "name");
const version = requiredString(packageJson, "version");
const repositoryMetadata = asObject(packageJson.repository, "package.json repository");
const repositoryUrl = requiredString(repositoryMetadata, "url");
const repositoryMatch = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/u.exec(repositoryUrl);
const repository = repositoryMatch?.[1];
if (repository === undefined) {
  throw new TypeError("package.json repository.url must name a GitHub repository");
}

const dependencySections = [
  ["dependencies", "runtime"],
  ["devDependencies", "development"],
  ["optionalDependencies", "optional"],
  ["peerDependencies", "peer"],
] as const satisfies readonly (readonly [string, DependencyScope])[];

const dependencies = dependencySections
  .flatMap(([section, scope]) => {
    const values = packageJson[section];
    if (values === undefined) return [];
    return Object.entries(asObject(values, `package.json ${section}`))
      .filter(([dependency]) => dependency.startsWith("@hraness/"))
      .map(([dependency, specifier]) => {
        if (typeof specifier !== "string" || specifier.length === 0) {
          throw new TypeError(`${section}.${dependency} must be a non-empty string`);
        }
        return { from: packageName, scope, specifier, to: dependency };
      });
  })
  .toSorted(
    (left, right) =>
      compareText(left.from, right.from) ||
      compareText(left.to, right.to) ||
      compareText(left.scope, right.scope) ||
      compareText(left.specifier, right.specifier),
  );

const expectedInventory = {
  contract: "hraness.portfolio-inventory/v1",
  formatVersion: 1,
  repository,
  components: [
    {
      kind: "package",
      name: packageName,
      path: ".",
      visibility: "public",
      version,
    },
  ],
  dependencies,
  deployments: [],
  brands: [],
  publications: [
    {
      component: packageName,
      packageName,
      repository,
    },
  ],
};
const expected = `${JSON.stringify(expectedInventory, null, 2)}\n`;
const actual = await readFile(resolve(root, "portfolio-inventory.json"), "utf8");

if (actual !== expected) {
  throw new Error(
    "portfolio-inventory.json must exactly match package metadata and sorted direct @hraness dependencies",
  );
}
