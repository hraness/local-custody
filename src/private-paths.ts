import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type OwnedPathKind = "file" | "directory" | "socket";

export interface OwnedPathExpectation {
  readonly kind: OwnedPathKind;
  /** Exact permission bits: `(mode & 0o777)` must equal this value. */
  readonly exactMode?: number;
  /** Exact hard-link count. Defaults to 1 for files and sockets. */
  readonly links?: number;
  readonly minimumBytes?: bigint;
  readonly maximumBytes?: bigint;
}

const ownerUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const kindMatches = (
  metadata: Awaited<ReturnType<typeof lstat>>,
  kind: OwnedPathKind,
): boolean =>
  kind === "file" ? metadata.isFile()
    : kind === "directory" ? metadata.isDirectory()
    : metadata.isSocket();

/**
 * Validate that `path` is a physical, owner-only filesystem object.
 *
 * Owner checks apply where `process.getuid` exists (POSIX). Every other
 * check — type, symlink, link count, mode, size — applies everywhere.
 */
export async function assertOwnedPath(
  path: string,
  expectation: OwnedPathExpectation,
): Promise<void> {
  const metadata = await lstat(path, { bigint: true });
  const uid = ownerUid();
  const expectedLinks = expectation.links ?? (expectation.kind === "directory" ? undefined : 1n);
  if (
    !kindMatches(metadata, expectation.kind)
    || metadata.isSymbolicLink()
    || (expectedLinks !== undefined && metadata.nlink !== BigInt(expectedLinks))
    || (uid !== undefined && metadata.uid !== BigInt(uid))
    || (expectation.exactMode !== undefined
      && (metadata.mode & 0o777n) !== BigInt(expectation.exactMode))
    || (expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes)
    || (expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes)
  ) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
}

/**
 * Resolve `path`, prove its parent is physical, create it mode-0700 when
 * missing, then prove it is an owned, private, canonical directory.
 * Returns the resolved absolute path.
 */
export async function ensurePrivateDirectory(path: string): Promise<string> {
  const resolved = resolve(path);
  const parent = await realpath(dirname(resolved));
  const absolute = join(parent, basename(resolved));
  try {
    await mkdir(absolute, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(absolute);
  if (
    await realpath(absolute) !== absolute
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (ownerUid() !== undefined && metadata.uid !== ownerUid())
    || (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Directory must be physical, owned, and private.");
  }
  return absolute;
}

/**
 * Open `path` without following links, prove it is an owned, private,
 * link-count-1 regular file within `maximumBytes`, and return its contents.
 */
export async function readPrivateFile(path: string, maximumBytes: number): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    const uid = ownerUid();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || (uid !== undefined && metadata.uid !== uid)
      || (metadata.mode & 0o077) !== 0
      || metadata.size > maximumBytes
    ) {
      throw new Error("Unsafe private file.");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes) throw new Error("Private file exceeds its size bound.");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
