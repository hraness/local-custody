// src/private-paths.ts
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
var PRIVATE_DIRECTORY_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var ownerUid = () => typeof process.getuid === "function" ? process.getuid() : undefined;
var kindMatches = (metadata, kind) => kind === "file" ? metadata.isFile() : kind === "directory" ? metadata.isDirectory() : metadata.isSocket();
async function assertOwnedPath(path, expectation) {
  const metadata = await lstat(path, { bigint: true });
  const uid = ownerUid();
  const expectedLinks = expectation.links ?? (expectation.kind === "directory" ? undefined : 1n);
  if (!kindMatches(metadata, expectation.kind) || metadata.isSymbolicLink() || expectedLinks !== undefined && metadata.nlink !== BigInt(expectedLinks) || uid !== undefined && metadata.uid !== BigInt(uid) || expectation.exactMode !== undefined && (metadata.mode & 0o777n) !== BigInt(expectation.exactMode) || expectation.ownerOnly === true && (metadata.mode & 0o077n) !== 0n || expectation.canonical === true && await realpath(path) !== path || expectation.minimumBytes !== undefined && metadata.size < expectation.minimumBytes || expectation.maximumBytes !== undefined && metadata.size > expectation.maximumBytes) {
    throw new Error(`Unsafe local ${expectation.kind}.`);
  }
  return { dev: Number(metadata.dev), ino: Number(metadata.ino) };
}
async function ensurePrivateDirectory(path) {
  const absolute = resolve(path);
  const parent = dirname(absolute);
  if (await realpath(parent) !== parent) {
    throw new Error("Directory parent must be physical.");
  }
  try {
    await mkdir(absolute, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (error) {
    if (error.code !== "EEXIST")
      throw error;
  }
  const metadata = await lstat(absolute);
  if (await realpath(absolute) !== absolute || !metadata.isDirectory() || metadata.isSymbolicLink() || ownerUid() !== undefined && metadata.uid !== ownerUid() || (metadata.mode & 63) !== 0) {
    throw new Error("Directory must be physical, owned, and private.");
  }
  return absolute;
}
async function readPrivateFile(path, maximumBytes) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    const uid = ownerUid();
    if (!metadata.isFile() || metadata.nlink !== 1 || uid !== undefined && metadata.uid !== uid || (metadata.mode & 63) !== 0 || metadata.size > maximumBytes) {
      throw new Error("Unsafe private file.");
    }
    const buffer = Buffer.alloc(maximumBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maximumBytes)
      throw new Error("Private file exceeds its size bound.");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// src/atomic-publish.ts
import { randomUUID } from "node:crypto";
import { constants as constants2 } from "node:fs";
import { link, open as open2, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
var safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;
var assertSafeName = (name) => {
  if (!safeFileName.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
};
var syncDirectory = async (directory) => {
  const handle = await open2(directory, constants2.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};
var writeStaged = async (staged, content) => {
  const handle = await open2(staged, constants2.O_CREAT | constants2.O_EXCL | constants2.O_WRONLY | constants2.O_NOFOLLOW, PRIVATE_FILE_MODE);
  try {
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
export {
  publishPrivateFile,
  createPrivateFileOnce
};
