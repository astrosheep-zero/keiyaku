import { lstat, rm, rmdir } from "node:fs/promises";
import type { KnownAkuma } from "./akuma.js";

export class AkumaResetStopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AkumaResetStopError";
  }
}

export async function removeKnownRegularFile(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink())
      throw new AkumaResetStopError(`Akuma custody is not a regular file: ${path}`);
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY")
      throw error;
  }
}

/**
 * Remove exactly the recognized custody of one Akuma entry. Unknown files and
 * directories stay; an entry whose unknown bytes remain keeps its directory.
 */
export async function removeAkumaCustody(entry: KnownAkuma): Promise<void> {
  for (const path of [
    entry.paths.log,
    `${entry.paths.heart}-wal`,
    `${entry.paths.heart}-shm`,
    `${entry.paths.leash}-wal`,
    `${entry.paths.leash}-shm`,
    entry.paths.leash,
    entry.paths.heart,
  ]) {
    await removeKnownRegularFile(path);
  }
  await removeEmptyDirectory(entry.paths.directory);
}
