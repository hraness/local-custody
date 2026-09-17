import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import {
  PRIVATE_FILE_MODE,
  assertOwnedPath,
  assertOwnedPathSync,
} from "./private-paths.js";

const safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;

const assertSafeName = (name: string): void => {
  if (!safeFileName.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
};

const syncDirectory = async (directory: string): Promise<void> => {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeStaged = async (
  staged: string,
  content: string | Buffer,
): Promise<void> => {
  const handle = await open(
    staged,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export interface PublishPrivateFileOptions {
  /**
   * Runs after the staged file is written and synced but before it is
   * renamed over the target. Throwing aborts the publish and removes the
   * staging file — the seam for compare-and-swap guards.
   */
  readonly beforeCommit?: (target: string) => void | Promise<void>;
}

/**
 * Atomically publish `content` as `name` inside an already-private directory:
 * create a unique temporary file mode-0600 without following links, write and
 * fsync it, run the optional commit guard, rename it over the target, fsync the
 * directory, then re-validate the published object.
 *
 * The rename is atomic for same-directory targets; a reader that validates the
 * published name after this returns sees complete content under private mode.
 */
export async function publishPrivateFile(
  directory: string,
  name: string,
  content: string | Buffer,
  options: PublishPrivateFileOptions = {},
): Promise<void> {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeStaged(temporary, content);
    await options.beforeCommit?.(target);
    await rename(temporary, target);
    await syncDirectory(directory);
    await assertOwnedPath(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 1,
    });
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Create `name` exactly once with private content: stage the bytes, then
 * hard-link the staging file to the target so an existing name is never
 * replaced. Returns whether this call created the file. The staging name is
 * always removed.
 */
export async function createPrivateFileOnce(
  directory: string,
  name: string,
  content: string | Buffer,
): Promise<"created" | "existing"> {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeStaged(temporary, content);
    try {
      await link(temporary, target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    }
    await syncDirectory(directory);
    await assertOwnedPath(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 2,
    });
    return "created";
  } finally {
    await unlink(temporary).catch(() => undefined);
    await syncDirectory(directory).catch(() => undefined);
  }
}

const writeStagedSync = (staged: string, content: string | Buffer): void => {
  const descriptor = openSync(
    staged,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    fchmodSync(descriptor, PRIVATE_FILE_MODE);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const syncDirectorySync = (directory: string): void => {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

/** Synchronous form of {@link createPrivateFileOnce} with identical steps. */
export function createPrivateFileOnceSync(
  directory: string,
  name: string,
  content: string | Buffer,
): "created" | "existing" {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    writeStagedSync(temporary, content);
    try {
      linkSync(temporary, target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "existing";
      throw error;
    }
    syncDirectorySync(directory);
    assertOwnedPathSync(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 2,
    });
    return "created";
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The staging name is best-effort cleanup only.
    }
    try {
      syncDirectorySync(directory);
    } catch {
      // Directory durability after cleanup is best-effort.
    }
  }
}
