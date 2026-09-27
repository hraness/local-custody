import {
  PRIVATE_FILE_MODE,
  assertOwnedPath,
  assertOwnedPathSync
} from "./chunk-xrgz1k0h.js";

// src/atomic-publish.ts
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { link, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
var safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;
var assertSafeName = (name) => {
  if (!safeFileName.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
};
var syncDirectory = async (directory) => {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
var writeStaged = async (staged, content) => {
  const handle = await open(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
};
async function publishPrivateFile(directory, name, content, options = {}) {
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
      links: 1
    });
  } catch (error) {
    await unlink(temporary).catch(() => {
      return;
    });
    throw error;
  }
}
async function createPrivateFileOnce(directory, name, content) {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    await writeStaged(temporary, content);
    try {
      await link(temporary, target);
    } catch (error) {
      if (error.code === "EEXIST")
        return "existing";
      throw error;
    }
    await syncDirectory(directory);
    await assertOwnedPath(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 2
    });
    return "created";
  } finally {
    await unlink(temporary).catch(() => {
      return;
    });
    await syncDirectory(directory).catch(() => {
      return;
    });
  }
}
var writeStagedSync = (staged, content) => {
  const descriptor = openSync(staged, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
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
var syncDirectorySync = (directory) => {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};
function createPrivateFileOnceSync(directory, name, content) {
  assertSafeName(name);
  const target = join(directory, name);
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    writeStagedSync(temporary, content);
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (error.code === "EEXIST")
        return "existing";
      throw error;
    }
    syncDirectorySync(directory);
    assertOwnedPathSync(target, {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 2
    });
    return "created";
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
    try {
      syncDirectorySync(directory);
    } catch {}
  }
}

export { publishPrivateFile, createPrivateFileOnce, createPrivateFileOnceSync };
