import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { nukeAliases } from "../alias/index.js";
import type { WorldRoot } from "../world.js";
import { knownAkuma, type KnownAkuma } from "./akuma.js";
import { akumaLineageCachePath } from "./lineage-cache.js";
import { settleAkumaKill } from "./akuma-owner.js";
import { acquireLeash } from "./control.js";
import { AkumaResetStopError, removeAkumaCustody, removeEmptyDirectory, removeKnownRegularFile } from "./custody.js";
import { classifyHeartSchema, readHeart, type HeldAkumaLeash } from "./heart/index.js";
import { akumaRunRoot, type AkumaPaths } from "./identity.js";

export { AkumaResetStopError } from "./custody.js";

async function hasAkumaCustody(paths: AkumaPaths): Promise<boolean> {
  try {
    const value = await lstat(paths.heart);
    return value.isFile() && !value.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

async function stopRunningAkuma(entry: KnownAkuma): Promise<HeldAkumaLeash> {
  const settled = await settleAkumaKill(entry.paths, undefined, true);
  if (settled.leash !== undefined) return settled.leash;
  throw new AkumaResetStopError(`Akuma ${entry.id} could not be stopped: ${settled.evidence}`);
}

async function removeEmptyAkumaRunRoot(world: WorldRoot): Promise<void> {
  const runRoot = akumaRunRoot(world);
  const cache = basename(akumaLineageCachePath(world));
  const custody = new Set([".gitignore", cache, `${cache}-wal`, `${cache}-shm`]);
  let names: readonly string[];
  try {
    names = await readdir(runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.some((name) => !custody.has(name))) return;
  for (const name of names) await removeKnownRegularFile(join(runRoot, name));
  await removeEmptyDirectory(runRoot);
  await removeEmptyDirectory(dirname(runRoot));
}

async function nukeAkumaEntries(world: WorldRoot): Promise<readonly KnownAkuma[]> {
  const entries: KnownAkuma[] = [];
  for (const entry of (await knownAkuma(world)).rows) {
    if (await hasAkumaCustody(entry.paths)) entries.push(entry);
  }
  return entries;
}

export async function stopAkuma(world: WorldRoot): Promise<() => Promise<void>> {
  const entries = await nukeAkumaEntries(world);
  const held: HeldAkumaLeash[] = [];
  let prepared = false;
  try {
    for (const entry of entries) {
      if ((await classifyHeartSchema(entry.paths)) === "unsupported") continue;
      const snapshot = await readHeart(entry.paths);
      const leash =
        snapshot.soul !== null && snapshot.latestBody?.end === undefined
          ? await stopRunningAkuma(entry)
          : await acquireLeash(entry.paths);
      if (leash === null) throw new AkumaResetStopError(`Akuma ${entry.id} could not be verified stopped`);
      try {
        const after = await readHeart(entry.paths);
        if (after.soul === null || after.latestBody?.end !== undefined) {
          held.push(leash);
          continue;
        }
        throw new AkumaResetStopError(`Akuma ${entry.id} stopped without a durable end`);
      } catch (error) {
        leash.release();
        throw error;
      }
    }
    prepared = true;
    return async () => {
      try {
        await nukeAliases(world);
        for (const entry of entries) await removeAkumaCustody(entry);
        await removeEmptyAkumaRunRoot(world);
      } finally {
        for (const leash of held.reverse()) leash.release();
      }
    };
  } finally {
    if (!prepared) {
      for (const leash of held.reverse()) leash.release();
    }
  }
}
