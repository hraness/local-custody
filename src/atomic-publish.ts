import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

import { PRIVATE_FILE_MODE, assertOwnedPath } from "./private-paths.js";

const safeFileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/u;

/**
 * Atomically publish `content` as `name` inside an already-private directory:
 * create a unique temporary file mode-0600 without following links, write and
 * fsync it, rename it over the target, then re-validate the published object.
 *
 * The rename is atomic for same-directory targets; a reader that validates the
 * published name after this returns sees complete content under private mode.
 */
export async function publishPrivateFile(
  directory: string,
  name: string,
  content: string | Buffer,
): Promise<void> {
  if (!safeFileName.test(name) || Buffer.byteLength(name) > 128) {
    throw new Error("Unsafe publish name.");
  }
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, join(directory, name));
    await assertOwnedPath(join(directory, name), {
      kind: "file",
      exactMode: PRIVATE_FILE_MODE,
      links: 1,
    });
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
