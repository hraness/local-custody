import { fstatSync, readSync } from "node:fs";
import { isatty } from "node:tty";

export const DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES = 65_536;

/**
 * Read a secret or handoff document from an already-open descriptor —
 * `--input-fd`, a passed pipe, or a protected file — never from argv or the
 * environment. Terminals are refused so a mistyped flag cannot leak a prompt.
 *
 * Returns fatal-decoded UTF-8. Trimming and parsing belong to the caller.
 */
export function readProtectedDescriptor(
  descriptor: number,
  options: Readonly<{ maximumBytes?: number }> = {},
): string {
  const maximumBytes = options.maximumBytes ?? DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Protected input bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("Protected input requires a valid descriptor.");
  }
  if (isatty(descriptor)) {
    throw new Error("Protected input does not read terminals.");
  }
  const metadata = fstatSync(descriptor, { bigint: true });
  if (metadata.isFile()) {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      (uid !== undefined && metadata.uid !== BigInt(uid))
      || (metadata.mode & 0o077n) !== 0n
    ) {
      throw new Error("Protected input file must be owned and private.");
    }
  }
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (true) {
    const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (read === 0) break;
    offset += read;
    if (offset > maximumBytes) throw new Error("Protected input exceeds its size bound.");
    if (offset === buffer.length) throw new Error("Protected input exceeds its size bound.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
}

/** Read protected input from stdin (descriptor 0). */
export function readProtectedStdin(
  options: Readonly<{ maximumBytes?: number }> = {},
): string {
  return readProtectedDescriptor(0, options);
}
