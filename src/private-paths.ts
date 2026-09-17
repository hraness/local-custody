import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export type OwnedPathKind = "file" | "directory" | "socket";

export interface OwnedPathExpectation {
  readonly kind: OwnedPathKind;
  /** Exact permission bits: `(mode & 0o777)` must equal this value. */
  readonly exactMode?: number;
  /** When true, group/other bits must be zero: `mode & 0o077 === 0`. */
  readonly ownerOnly?: boolean;
  /** Exact hard-link count. Defaults to 1 for files and sockets. */
  readonly links?: number;
  /** When true, `path` must already be its own canonical realpath. */
  readonly canonical?: boolean;
  readonly minimumBytes?: bigint;
  readonly maximumBytes?: bigint;
}

/** Device and inode identity of a validated filesystem object. */
export interface OwnedPathIdentity {
  readonly dev: number;
  readonly ino: number;
}

/** Contents plus identity of a file that passed a stable bounded read. */
export interface OwnedFileRead {
  readonly bytes: Buffer;
  readonly dev: number;
  readonly ino: number;
}

/** Optional overrides for the file expectations checked during a stable read. */
export interface StableFileExpectation {
  /** Exact permission bits. Overrides `ownerOnly` when set. */
  readonly exactMode?: number;
  /** When unset, group/other bits must be zero: `mode & 0o077 === 0`. */
  readonly ownerOnly?: boolean;
  /** Exact hard-link count. Defaults to 1. */
  readonly links?: number;
  /** Minimum accepted file size. */
  readonly minimumBytes?: bigint;
}

const ownerUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const kindMatches = (
  metadata: { isFile(): boolean; isDirectory(): boolean; isSocket(): boolean },
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
): Promise<OwnedPathIdentity> {
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
    || (expectation.ownerOnly === true && (metadata.mode & 0o077n) !== 0n)
    || (expectation.canonical === true && (await realpath(path)) !== path)
    || (expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes)
    || (expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes)
  ) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
  return { dev: Number(metadata.dev), ino: Number(metadata.ino) };
}

/** Synchronous form of {@link assertOwnedPath} with identical checks. */
export function assertOwnedPathSync(
  path: string,
  expectation: OwnedPathExpectation,
): OwnedPathIdentity {
  const metadata = lstatSync(path, { bigint: true });
  const uid = ownerUid();
  const expectedLinks = expectation.links ?? (expectation.kind === "directory" ? undefined : 1n);
  if (
    !kindMatches(metadata, expectation.kind)
    || metadata.isSymbolicLink()
    || (expectedLinks !== undefined && metadata.nlink !== BigInt(expectedLinks))
    || (uid !== undefined && metadata.uid !== BigInt(uid))
    || (expectation.exactMode !== undefined
      && (metadata.mode & 0o777n) !== BigInt(expectation.exactMode))
    || (expectation.ownerOnly === true && (metadata.mode & 0o077n) !== 0n)
    || (expectation.canonical === true && realpathSync(path) !== path)
    || (expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes)
    || (expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes)
  ) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
  return { dev: Number(metadata.dev), ino: Number(metadata.ino) };
}

/**
 * Create `path` mode-0700 when missing, then prove it is an owned, private,
 * canonical directory. The parent chain must already be physical — a
 * symlinked ancestor fails closed rather than retargeting the directory.
 * Returns the resolved absolute path.
 */
export async function ensurePrivateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if ((await realpath(parent)) !== parent) {
    throw new Error("Directory parent must be physical.");
  }
  try {
    await mkdir(absolute, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(absolute);
  if (
    (await realpath(absolute)) !== absolute
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (ownerUid() !== undefined && metadata.uid !== ownerUid())
    || (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("Directory must be physical, owned, and private.");
  }
  return absolute;
}

type StableStat = {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mode: bigint;
  uid: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

const checkStableCandidate = (
  before: StableStat,
  maximumBytes: number,
  expectation: StableFileExpectation,
): void => {
  const uid = ownerUid();
  const links = BigInt(expectation.links ?? 1);
  if (
    !before.isFile()
    || before.nlink !== links
    || (uid !== undefined && before.uid !== BigInt(uid))
    || (expectation.exactMode !== undefined
      ? (before.mode & 0o777n) !== BigInt(expectation.exactMode)
      : expectation.ownerOnly !== false && (before.mode & 0o077n) !== 0n)
    || (expectation.minimumBytes !== undefined && before.size < expectation.minimumBytes)
    || before.size > BigInt(maximumBytes)
  ) {
    throw new Error("Unsafe private file.");
  }
};

const checkStableResult = (before: StableStat, after: StableStat): void => {
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.nlink !== before.nlink
    || after.mode !== before.mode
    || after.uid !== before.uid
    || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs
  ) {
    throw new Error("Private file changed during the read.");
  }
};

/**
 * Read `path` while proving the file did not change during the read:
 * open without following links, validate the descriptor, read exactly the
 * observed size, then re-`lstat` the path and require the same object —
 * device, inode, link count, mode, owner, size, mtime, and ctime all
 * identical at nanosecond precision. Returns the bytes with the read
 * object's device/inode identity.
 */
export async function readOwnedFileStable(
  path: string,
  maximumBytes: number,
  expectation: StableFileExpectation = {},
): Promise<OwnedFileRead> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat({ bigint: true });
    checkStableCandidate(before, maximumBytes, expectation);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await lstat(path, { bigint: true });
    checkStableResult(before, after);
    if (offset !== buffer.byteLength) {
      throw new Error("Private file changed during the read.");
    }
    return { bytes: buffer, dev: Number(before.dev), ino: Number(before.ino) };
  } finally {
    await handle.close();
  }
}

/** Synchronous form of {@link readOwnedFileStable} with identical checks. */
export function readOwnedFileStableSync(
  path: string,
  maximumBytes: number,
  expectation: StableFileExpectation = {},
): OwnedFileRead {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    checkStableCandidate(before, maximumBytes, expectation);
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        offset,
        buffer.byteLength - offset,
        null,
      );
      if (count === 0) break;
      offset += count;
    }
    const after = lstatSync(path, { bigint: true });
    checkStableResult(before, after);
    if (offset !== buffer.byteLength) {
      throw new Error("Private file changed during the read.");
    }
    return { bytes: buffer, dev: Number(before.dev), ino: Number(before.ino) };
  } finally {
    closeSync(descriptor);
  }
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
