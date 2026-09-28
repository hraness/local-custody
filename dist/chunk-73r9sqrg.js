// src/protected-input.ts
import { fstatSync, readSync } from "node:fs";
import { isatty } from "node:tty";
var DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES = 65536;

class ProtectedInputError extends Error {
  name = "ProtectedInputError";
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
var PROTECTED_INPUT_TERMINAL_MESSAGE = "Pipe or redirect the value in instead of typing it, so it stays out of your terminal history.";
function readProtectedDescriptor(descriptor, options = {}) {
  const maximumBytes = options.maximumBytes ?? DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Protected input bound must be a positive integer.");
  }
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error("Protected input requires a valid descriptor.");
  }
  if (isatty(descriptor)) {
    throw new ProtectedInputError("protected-terminal", PROTECTED_INPUT_TERMINAL_MESSAGE);
  }
  const metadata = fstatSync(descriptor, { bigint: true });
  if (metadata.isFile()) {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && metadata.uid !== BigInt(uid) || (metadata.mode & 0o077n) !== 0n) {
      throw new ProtectedInputError("protected-unsafe-file", "Protected input file must be owned and private.");
    }
  }
  const buffer = Buffer.alloc(maximumBytes + 1);
  let offset = 0;
  while (true) {
    const read = readSync(descriptor, buffer, offset, buffer.length - offset, null);
    if (read === 0)
      break;
    offset += read;
    if (offset > maximumBytes)
      throw new ProtectedInputError("protected-too-large", "Protected input exceeds its size bound.");
    if (offset === buffer.length)
      throw new ProtectedInputError("protected-too-large", "Protected input exceeds its size bound.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
}
function readProtectedStdin(options = {}) {
  return readProtectedDescriptor(0, options);
}

export { DEFAULT_PROTECTED_INPUT_MAXIMUM_BYTES, ProtectedInputError, PROTECTED_INPUT_TERMINAL_MESSAGE, readProtectedDescriptor, readProtectedStdin };
