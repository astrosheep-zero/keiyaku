import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { readSoul } from "./heart/index.js";
import { akumaRunRoot, parseAkumaId, type AkumaId, type AkumaPaths } from "./identity.js";
import { boundedMap } from "./read-pool.js";
import type { WorldRoot } from "../world.js";

/**
 * The World-local lineage cache is a disposable reconstruction of the frozen
 * `Soul.caller` edge for born Akuma. It is never authority: every entry can be
 * rebuilt from Hearts, and an unavailable cache falls back to direct Soul reads.
 */
export type AkumaLineage = ReadonlyMap<AkumaId, AkumaCaller | null>;
type LineageObservation = Readonly<{ edges: AkumaLineage; skipped: number }>;

export type LineageMember = Readonly<{ id: AkumaId; paths: AkumaPaths }>;

const CACHE_FILE = "lineage-cache.sqlite";
const LINEAGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS lineage (
    aku_id TEXT PRIMARY KEY,
    caller_json TEXT
  ) STRICT;
`;

export function akumaLineageCachePath(world: WorldRoot): string {
  return join(akumaRunRoot(world), CACHE_FILE);
}

function readCachedEdge(row: unknown): readonly [AkumaId, AkumaCaller | null] {
  const value = row as Readonly<{ aku_id?: unknown; caller_json?: unknown }> | null;
  if (value === null || typeof value !== "object") throw new Error("Akuma lineage cache row is not an object");
  if (typeof value.aku_id !== "string") throw new Error("Akuma lineage cache row has no identity");
  const akumaId = parseAkumaId(value.aku_id).id;
  if (value.caller_json === null) return [akumaId, null];
  if (typeof value.caller_json !== "string") throw new Error("Akuma lineage cache row has no caller evidence");
  const caller = decodeAkumaCaller(JSON.parse(value.caller_json));
  if (caller === undefined) throw new Error("Akuma lineage cache row has an empty caller");
  return [akumaId, caller];
}

/** Decode only current members; obsolete and invalid rows are disposable misses. */
async function readLineageCache(
  path: string,
  known: ReadonlySet<string>,
): Promise<{ edges: Map<AkumaId, AkumaCaller | null>; stale: string[] } | null> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { edges: new Map(), stale: [] };
    return null;
  }
  let database: DatabaseSync;
  try {
    // Existing custody is opened without a journal-mode constraint: a writer's
    // WAL side files stay usable, and a busy or unreadable record falls back.
    database = new DatabaseSync(path);
  } catch {
    return null;
  }
  try {
    database.exec("PRAGMA busy_timeout=0");
    const rows = database.prepare("SELECT aku_id, caller_json FROM lineage").all();
    const edges = new Map<AkumaId, AkumaCaller | null>();
    const stale: string[] = [];
    for (const row of rows) {
      if (typeof row.aku_id !== "string") continue;
      if (known.has(row.aku_id)) {
        try {
          const [id, caller] = readCachedEdge(row);
          edges.set(id, caller);
          continue;
        } catch {
          // A malformed current edge is a miss, not a reason to discard peers.
        }
      }
      stale.push(row.aku_id);
    }
    return { edges, stale };
  } catch {
    return null;
  } finally {
    database.close();
  }
}

async function writeLineageCache(
  path: string,
  fresh: readonly (readonly [AkumaId, AkumaCaller | null])[],
  stale: readonly string[],
  replace = false,
): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA busy_timeout=0");
      database.exec("PRAGMA journal_mode=WAL");
      database.exec(LINEAGE_SCHEMA);
      const insert = database.prepare("INSERT OR REPLACE INTO lineage(aku_id, caller_json) VALUES (?, ?)");
      const remove = database.prepare("DELETE FROM lineage WHERE aku_id = ?");
      database.exec("BEGIN IMMEDIATE");
      try {
        if (replace) database.exec("DELETE FROM lineage");
        for (const akumaId of stale) remove.run(akumaId);
        for (const [akumaId, caller] of fresh) insert.run(akumaId, caller === null ? null : JSON.stringify(caller));
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch {
    /* The cache is disposable; a failed refresh never changes an Akuma result. */
  }
}

async function directEdge(member: LineageMember): Promise<readonly [AkumaId, AkumaCaller | null] | null | undefined> {
  try {
    const soul = await readSoul(member.paths);
    if (soul !== null && soul.id !== member.id) throw new Error("Akuma soul does not match its coordinate");
    return soul === null ? null : [member.id, soul.caller ?? null];
  } catch {
    // Unreadability is not authoritative absence and cannot justify a rebuild.
    return undefined;
  }
}

/** Authoritative lineage read: every known born Soul, with no cache consultation. */
export async function readDirectAkumaLineage(members: readonly LineageMember[]): Promise<LineageObservation> {
  const observed = await boundedMap(members, directEdge);
  return {
    edges: new Map(observed.filter((edge) => edge !== null && edge !== undefined)),
    skipped: observed.filter((edge) => edge === undefined).length,
  };
}

/**
 * Discard the disposable record when an offered edge disagrees with a born
 * Soul. The next caller-scoped answer comes from direct Soul evidence and
 * rewrites the record, so a wrong edge can never survive as accepted fact.
 */
export async function invalidateAkumaLineage(world: WorldRoot): Promise<void> {
  const path = akumaLineageCachePath(world);
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      await rm(file, { force: true });
    } catch {
      /* Best effort: a still-readable record is checked again by the next query. */
    }
  }
}

/** Rewrite every edge from authoritative evidence, dropping any stale entry. */
export async function rebuildAkumaLineage(world: WorldRoot, edges: AkumaLineage): Promise<void> {
  await writeLineageCache(akumaLineageCachePath(world), [...edges], [], true);
}

/**
 * Record one born Soul's immutable caller edge. Best-effort: callers never await
 * this to decide birth, and a failed write is repaired by the next fallback read.
 */
export async function recordAkumaLineage(
  world: WorldRoot,
  soul: Readonly<{ id: AkumaId; caller?: AkumaCaller }>,
): Promise<void> {
  await writeLineageCache(akumaLineageCachePath(world), [[soul.id, soul.caller ?? null]], []);
}

/**
 * Load the caller edge of every currently known Akuma. Cache hits avoid opening
 * their Hearts; misses and unusable caches fall back to the existing Soul seam.
 * Rows whose Akuma directory no longer exists never join this view, and fresh
 * edges plus that pruning are written back best-effort.
 */
export async function readAkumaLineage(
  world: WorldRoot,
  members: readonly LineageMember[],
): Promise<LineageObservation> {
  const path = akumaLineageCachePath(world);
  const cached = await readLineageCache(path, new Set(members.map((member) => member.id)));
  if (cached === null) {
    const direct = await readDirectAkumaLineage(members);
    if (direct.skipped === 0) {
      await invalidateAkumaLineage(world);
      await rebuildAkumaLineage(world, direct.edges);
    }
    return direct;
  }
  const missing = members.filter((member) => !cached.edges.has(member.id));
  const fresh = await readDirectAkumaLineage(missing);
  for (const [akumaId, caller] of fresh.edges) cached.edges.set(akumaId, caller);
  if (fresh.edges.size > 0 || cached.stale.length > 0) await writeLineageCache(path, [...fresh.edges], cached.stale);
  return { edges: cached.edges, skipped: fresh.skipped };
}
