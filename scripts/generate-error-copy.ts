// Writes rust/src/error-copy.json from the TypeScript copy table in
// src/describe.ts, so the Rust crate's describe_error says exactly what
// describeCustodyError says. `--check` fails when the file has drifted.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { CUSTODY_ACTIVITY_CODES, CUSTODY_ERROR_CODES, CUSTODY_ERROR_COPY } from "../src/describe.ts";

const output = resolve(import.meta.dir, "..", "rust", "src", "error-copy.json");
const sorted = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]!]));
const text = `${JSON.stringify({
  copy: sorted(CUSTODY_ERROR_COPY),
  codes: sorted(CUSTODY_ERROR_CODES),
  activityCodes: Object.fromEntries(Object.keys(CUSTODY_ACTIVITY_CODES).sort().map((activity) =>
    [activity, sorted(CUSTODY_ACTIVITY_CODES[activity as keyof typeof CUSTODY_ACTIVITY_CODES])])),
}, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== text) {
    console.error("rust/src/error-copy.json is out of date. Run: bun run generate:error-copy");
    process.exit(1);
  }
} else {
  await writeFile(output, text);
}
