import { lstat, readdir, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nukeAliases } from "../alias/index.js";
import type { WorldRoot } from "../world.js";
import { CONTROL_RESPONSE_MS } from "./body.js";
import { HeldAkumaLeash, readHeart, readKill, requestStop } from "./heart/index.js";
import { akuIdFromDirectoryName, akumaPaths, akumaRunRoot, type AkuId, type AkumaPaths } from "./identity.js";

const POLL_MS = 100;

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
    await wait(Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
  }
}

async function stopRunningAkuma(entry: NukeAkumaEntry): Promise<HeldAkumaLeash> {
  const request = await requestStop(entry.paths, new Date().toISOString());
  const leash = await takeLeashUntil(entry.paths, performance.now() + CONTROL_RESPONSE_MS);
  if (leash === null) throw new Error(`Akuma ${entry.id} could not be stopped: unavailable`);
  try {
    if (request.kind === "already-killed" || request.kind === "already-stopped") return leash;
    if ((await readKill(entry.paths, request.body.sequence)) !== null) return leash;
    const current = await readHeart(entry.paths);
    if (current.latestBody?.sequence !== request.body.sequence) {
      if ((await readKill(entry.paths, request.body.sequence)) !== null) return leash;
      throw new Error(`Akuma ${entry.id} could not be stopped: unavailable`);
    }
    if (current.latestBody.end !== "put-down") {
      await leash.clearStop(entry.paths);
      throw new Error(`Akuma ${entry.id} could not be stopped: untidy`);
    }
    if ((await leash.settleStop(entry.paths, request.body.sequence)) === null) {
      throw new Error(`Akuma ${entry.id} could not be stopped: unavailable`);
    }
    return leash;
  } catch (error) {
    leash.release();
    throw error;
  }
}

async function removeKnownRegularFile(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) throw new Error(`Akuma custody is not a regular file: ${path}`);
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
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
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`Akuma custody is not a directory: ${path}`);
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

async function removeAkumaEntry(entry: NukeAkumaEntry): Promise<void> {
  await removeKnownRequestChannel(entry.paths.requests);
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

async function removeEmptyAkumaRunRoot(world: WorldRoot): Promise<void> {
  const runRoot = akumaRunRoot(world);
  let names: readonly string[];
  try {
    names = await readdir(runRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (names.some((name) => name !== ".gitignore")) return;
  if (names.includes(".gitignore")) await removeKnownRegularFile(join(runRoot, ".gitignore"));
  await removeEmptyDirectory(runRoot);
  await removeEmptyDirectory(dirname(runRoot));
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
      const leash =
        snapshot.soul !== null && snapshot.latestBody?.end === undefined
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
        await removeEmptyAkumaRunRoot(world);
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
