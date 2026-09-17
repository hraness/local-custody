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
export {
  readPrivateFile,
  ensurePrivateDirectory,
  assertOwnedPath,
  PRIVATE_FILE_MODE,
  PRIVATE_DIRECTORY_MODE
};
