import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
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

function isRequestSequenceName(name: string): boolean {
  const sequence = Number(name);
  return /^\d+$/u.test(name) && Number.isSafeInteger(sequence) && String(sequence) === name;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isRequestArtifactName(name: string): boolean {
  const match = /^(.*)\.(?:request|receipt)\.json$/u.exec(name);
  return match !== null && UUID_V4.test(match[1]!);
}

async function removeKnownRequestFile(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) return;
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeKnownRequestChannel(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink())
      throw new AkumaResetStopError(`Akuma custody is not a directory: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of await readdir(path)) {
    if (!isRequestSequenceName(name)) continue;
    const sequenceDir = join(path, name);
    try {
      const sequence = await lstat(sequenceDir);
      if (!sequence.isDirectory() || sequence.isSymbolicLink()) continue;
      for (const child of await readdir(sequenceDir)) {
        if (isRequestArtifactName(child)) await removeKnownRequestFile(join(sequenceDir, child));
      }
      await removeEmptyDirectory(sequenceDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await removeEmptyDirectory(path);
}

/**
 * Remove exactly the recognized custody of one Akuma entry. Unknown files and
 * directories stay; an entry whose unknown bytes remain keeps its directory.
 */
export async function removeAkumaCustody(entry: KnownAkuma): Promise<void> {
  await removeKnownRequestChannel(entry.paths.requests);
  for (const path of [
    join(entry.paths.directory, "request-entry.json"),
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
