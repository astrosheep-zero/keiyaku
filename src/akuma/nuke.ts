import { lstat, readdir, rm } from "node:fs/promises";
import { nukeAliases } from "../alias/index.js";
import type { WorldRoot } from "../world.js";
import { CONTROL_RESPONSE_MS } from "./body.js";
import {
  HeldAkumaLeash,
  readHeart,
  readKill,
  requestStop,
} from "./heart/index.js";
import {
  akuIdFromDirectoryName,
  akumaPaths,
  akumaRunRoot,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";

const POLL_MS = 25;

type NukeAkumaEntry = Readonly<{ id: AkuId; paths: AkumaPaths }>;

async function hasAkumaCustody(paths: AkumaPaths): Promise<boolean> {
  try {
    const value = await lstat(paths.heart);
    return value.isFile() && !value.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function takeLeashUntil(paths: AkumaPaths, deadline: number): Promise<HeldAkumaLeash | null> {
  for (;;) {
    const leash = await HeldAkumaLeash.try(paths);
    if (leash !== null) return leash;
    if (performance.now() >= deadline) return null;
    await wait(POLL_MS);
  }
}

async function stopRunningAkuma(entry: NukeAkumaEntry): Promise<HeldAkumaLeash> {
  const request = await requestStop(entry.paths, new Date().toISOString());
  const leash = await takeLeashUntil(entry.paths, performance.now() + CONTROL_RESPONSE_MS);
  if (leash === null) throw new Error(`Akuma ${entry.id} could not be stopped: unavailable`);
  try {
    if (request.kind === "already-killed" || request.kind === "already-stopped") return leash;
    if (await readKill(entry.paths, request.body.sequence) !== null) return leash;
    const current = await readHeart(entry.paths);
    if (current.latestBody?.sequence !== request.body.sequence) {
      if (await readKill(entry.paths, request.body.sequence) !== null) return leash;
      throw new Error(`Akuma ${entry.id} could not be stopped: unavailable`);
    }
    if (current.latestBody.end !== "put-down") {
      await leash.clearStop(entry.paths);
      throw new Error(`Akuma ${entry.id} could not be stopped: untidy`);
    }
    if (await leash.settleStop(entry.paths, request.body.sequence) === null) {
      throw new Error(`Akuma ${entry.id} could not be stopped: unavailable`);
    }
    return leash;
  } catch (error) {
    leash.release();
    throw error;
  }
}

async function removeRegularFile(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (value.isFile() && !value.isSymbolicLink()) await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeAkumaEntry(entry: NukeAkumaEntry): Promise<void> {
  for (const path of [entry.paths.heart, entry.paths.log,
    `${entry.paths.heart}-wal`, `${entry.paths.heart}-shm`]) {
    await removeRegularFile(path);
  }
}

async function nukeAkumaEntries(world: WorldRoot): Promise<readonly NukeAkumaEntry[]> {
  const runRoot = akumaRunRoot(world);
  let names: readonly string[];
  try {
    names = (await readdir(runRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else throw error;
  }

  const entries: NukeAkumaEntry[] = [];
  for (const name of names) {
    let physical: ReturnType<typeof akuIdFromDirectoryName>;
    try {
      physical = akuIdFromDirectoryName(name);
    } catch {
      // The run root can contain bytes not produced by Keiyaku. Preserve them.
      continue;
    }
    const paths = akumaPaths({ runRoot, archetype: physical.archetype, suffix: physical.suffix });
    if (!(await hasAkumaCustody(paths))) continue;
    entries.push({ id: physical.id, paths });
  }
  return entries;
}

export async function stopAkuma(world: WorldRoot): Promise<() => Promise<void>> {
  const entries = await nukeAkumaEntries(world);
  const held: HeldAkumaLeash[] = [];
  try {
    for (const entry of entries) {
      const snapshot = await readHeart(entry.paths);
      const leash = snapshot.soul !== null && snapshot.latestBody?.end === undefined
        ? await stopRunningAkuma(entry)
        : await takeLeashUntil(entry.paths, performance.now() + CONTROL_RESPONSE_MS);
      if (leash === null) throw new Error(`Akuma ${entry.id} could not be verified stopped`);
      try {
        const after = await readHeart(entry.paths);
        if (after.soul === null || after.latestBody?.end !== undefined) {
          held.push(leash);
          continue;
        }
        throw new Error(`Akuma ${entry.id} stopped without a durable end`);
      } catch (error) {
        leash.release();
        throw error;
      }
    }
    return async () => {
      try {
        await nukeAliases(world);
        for (const entry of entries) await removeAkumaEntry(entry);
      } finally {
        for (const leash of held.reverse()) leash.release();
      }
    };
  } finally {
    if (held.length !== entries.length) {
      for (const leash of held.reverse()) leash.release();
    }
  }
}
