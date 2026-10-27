import { akumaBirthSchema, akumaCallerKey, decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";
import { rosterListRow } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import { allowedActionsSchema } from "./allowed.js";
import type { AkumaLife } from "./heart/index.js";
import { readSoul } from "./heart/index.js";
import {
  akuIdFromDirectoryName,
  akumaIdSchema,
  akumaPaths,
  akumaRunRoot,
  parseAkuId,
  pathsForAkuId,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
import { validateAkumaName } from "../identity/normalize.js";
import {
  readAkumaLineage,
  readDirectAkumaLineage,
  invalidateAkumaLineage,
  rebuildAkumaLineage,
  type AkumaLineage,
} from "./lineage-cache.js";
import { activitySnapshotSchema } from "./projection.js";
import { PAGE_POOL_SIZE, boundedMap } from "./read-pool.js";

export type AkumaListRow = Readonly<{
  id: AkuId;
  archetype: string;
  description?: string;
  life: AkumaLife;
  lifeAt: string | null;
  lastActivityAt: string | null;
  pending: readonly string[];
  aliases: readonly AkumaAlias[];
  caller?: AkumaCaller;
}>;

export type UnbornAkumaListRow = Readonly<{
  id: AkuId;
  life: "unborn" | "stillborn";
  aliases: readonly AkumaAlias[];
  seal?: Readonly<{ evidence: string; at: string }>;
}>;

export type AkumaList = BoundedList<AkumaListRow | UnbornAkumaListRow> &
  Readonly<{
    observedAt: string;
    searched: readonly string[];
  }>;

export type AkumaCompleteList = Omit<AkumaList, "hasMore">;

export type AkumaListInput = Readonly<{
  archetype?: string;
  caller?: AkumaCaller;
  limit?: number;
}>;

export const akumaStatusSchema = z
  .object({
    id: akumaIdSchema,
    birth: akumaBirthSchema,
    life: z.enum(["running", "asleep", "stranded", "hung", "untidy", "killed"]),
    cwd: z.string().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    allowed: allowedActionsSchema,
    timeline: activitySnapshotSchema,
    strandedReason: z.literal("resume-unsupported").optional(),
  })
  .strict();
export type AkumaStatus = z.infer<typeof akumaStatusSchema>;

type AkumaListRowValue = AkumaListRow | UnbornAkumaListRow;

/** One recognized Akuma directory under this World's run root. */
export type KnownAkuma = Readonly<{ id: AkuId; paths: AkumaPaths }>;

function activityAt(row: AkumaListRowValue): string | null {
  if (!("lifeAt" in row)) return null;
  if (row.lifeAt === null) return row.lastActivityAt;
  if (row.lastActivityAt === null) return row.lifeAt;
  return row.lifeAt > row.lastActivityAt ? row.lifeAt : row.lastActivityAt;
}

function compareActivity(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left > right ? -1 : 1;
}

function compareRows(left: AkumaListRowValue, right: AkumaListRowValue): number {
  const activity = compareActivity(activityAt(left), activityAt(right));
  if (activity !== 0) return activity;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

async function mtimeBound(paths: AkumaPaths): Promise<number> {
  const read = async (path: string): Promise<number> => {
    try {
      return (await stat(path)).mtimeMs;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : Number.POSITIVE_INFINITY;
    }
  };
  return Math.max(await read(paths.heart), await read(`${paths.heart}-wal`));
}

/** Enumerate the recognized Akuma directories under this World's run root. */
export async function knownAkuma(
  path: WorldRoot,
  selected?: string,
): Promise<Readonly<{ runRoot: string; rows: readonly KnownAkuma[] }>> {
  const runRoot = akumaRunRoot(path);
  let names: string[];
  try {
    names = (await readdir(runRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { runRoot, rows: [] };
    throw error;
  }
  const rows: KnownAkuma[] = [];
  for (const name of names) {
    let physical: ReturnType<typeof akuIdFromDirectoryName>;
    try {
      physical = akuIdFromDirectoryName(name);
    } catch {
      // The run root can contain bytes not produced by Keiyaku. Preserve them.
      continue;
    }
    if (selected !== undefined && physical.archetype !== selected) continue;
    rows.push({
      id: physical.id,
      paths: akumaPaths({ runRoot, archetype: physical.archetype, suffix: physical.suffix }),
    });
  }
  return { runRoot, rows };
}

async function readableRows(
  rows: readonly KnownAkuma[],
): Promise<Readonly<{ rows: readonly AkumaListRowValue[]; skipped: number }>> {
  const loaded = await boundedMap(rows, async ({ id, paths }) => {
    try {
      return await rosterListRow(paths, id);
    } catch {
      return null;
    }
  });
  const values = [...loaded].filter((row): row is AkumaListRowValue => row !== null);
  return { rows: values, skipped: loaded.length - values.length };
}

function rosterInput(
  input: AkumaListInput | Readonly<{ archetype?: string }>,
  allowLimit: boolean,
): Readonly<{ archetype?: string; caller?: AkumaCaller }> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("Akuma list input must be an object");
  const allowed = allowLimit ? ["archetype", "caller", "limit"] : ["archetype", "caller"];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Akuma list input has unknown field: ${unknown}`);
  const caller = decodeAkumaCaller((input as AkumaListInput).caller);
  return {
    ...(input.archetype === undefined ? {} : { archetype: validateAkumaName(input.archetype) }),
    ...(caller === undefined ? {} : { caller }),
  };
}

/**
 * The caller closure follows only frozen Soul edges: the exact root coordinate,
 * then Akuma coordinates inside this selected World. Fork origin is not an edge.
 * Known identities deduplicate repeated and cyclic edges.
 */
function callerClosure(lineage: AkumaLineage, root: AkumaCaller, world: WorldRoot): ReadonlySet<AkuId> {
  if (root.kind === "akuma" && root.world !== world) return new Set();
  const children = new Map<string, AkuId[]>();
  for (const [akuId, caller] of lineage) {
    if (caller === null) continue;
    const key = akumaCallerKey(caller);
    const siblings = children.get(key);
    if (siblings === undefined) children.set(key, [akuId]);
    else siblings.push(akuId);
  }
  const included = new Set<AkuId>();
  const visited = new Set<string>();
  const queue: AkumaCaller[] = [root];
  while (queue.length > 0) {
    const caller = queue.shift()!;
    const key = akumaCallerKey(caller);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const akuId of children.get(key) ?? []) {
      if (included.has(akuId)) continue;
      included.add(akuId);
      queue.push({ kind: "akuma", world, akuId });
    }
  }
  return included;
}

async function boundedCallerRows(
  candidates: readonly (KnownAkuma & Readonly<{ bound: number }>)[],
  limit: number,
): Promise<Readonly<{ rows: readonly AkumaListRowValue[]; skipped: number }>> {
  const readable: AkumaListRowValue[] = [];
  let skipped = 0;
  let cursor = 0;
  while (cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + PAGE_POOL_SIZE);
    const observed = await readableRows(batch);
    readable.push(...observed.rows);
    skipped += observed.skipped;
    cursor += batch.length;
    const ranked = readable.sort(compareRows);
    const lookahead = ranked[limit];
    const activity = lookahead === undefined ? null : activityAt(lookahead);
    const unreadBound = candidates[cursor]?.bound;
    if (
      lookahead !== undefined &&
      activity !== null &&
      unreadBound !== undefined &&
      Number.isFinite(unreadBound) &&
      Number.isFinite(Date.parse(activity)) &&
      unreadBound < Date.parse(activity)
    ) {
      break;
    }
  }
  return { rows: readable.sort(compareRows), skipped };
}

type MemberVerdict = "included" | "excluded" | "unknown" | "invalid-cache";

type SoulEdge =
  | Readonly<{ kind: "born"; caller: AkumaCaller | null }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable" }>;

function sameCallerEvidence(left: AkumaCaller | null, right: AkumaCaller | null): boolean {
  if (left === null || right === null) return left === right;
  return akumaCallerKey(left) === akumaCallerKey(right);
}

async function readCallerSoul(world: WorldRoot, akuId: AkuId): Promise<SoulEdge> {
  try {
    const soul = await readSoul(pathsForAkuId(world, akuId));
    return soul === null ? { kind: "absent" } : { kind: "born", caller: soul.caller ?? null };
  } catch {
    return { kind: "unreadable" };
  }
}

type CallerVerification = Readonly<{
  world: WorldRoot;
  root: AkumaCaller;
  lineage: AkumaLineage;
  souls: Map<AkuId, Promise<SoulEdge>>;
}>;

async function soulEdgeFor(verification: CallerVerification, akuId: AkuId): Promise<SoulEdge> {
  const observed = verification.souls.get(akuId);
  if (observed !== undefined) return await observed;
  const pending = readCallerSoul(verification.world, akuId);
  verification.souls.set(akuId, pending);
  return await pending;
}

/**
 * The cache may propose a member; only the born Soul chain can justify it. Each
 * returned member's own edge is compared with its born Soul, and every parent
 * link on that chain is proven the same way back to the exact query root.
 * Any disagreement means the record cannot be trusted for this answer.
 */
async function verifyCallerMember(
  verification: CallerVerification,
  id: AkuId,
  observedCaller: AkumaCaller | undefined,
): Promise<MemberVerdict> {
  const { lineage, root } = verification;
  const rowCaller = observedCaller ?? null;
  const cached = lineage.get(id);
  if (cached === undefined) return "invalid-cache";
  if (!sameCallerEvidence(cached, rowCaller)) return "invalid-cache";
  const rootKey = akumaCallerKey(root);
  const seen = new Set<string>();
  let current = rowCaller;
  for (;;) {
    if (current === null) return "excluded";
    const key = akumaCallerKey(current);
    if (key === rootKey) return "included";
    if (seen.has(key)) return "excluded";
    seen.add(key);
    if (current.kind === "external") return "excluded";
    if (current.world !== verification.world) return "excluded";
    const parentId = current.akuId;
    const parentCached = lineage.get(parentId);
    const edge = await soulEdgeFor(verification, parentId);
    if (edge.kind === "unreadable") return "unknown";
    // A cached parent that has no born Soul cannot seed a real chain.
    if (edge.kind === "absent") return "invalid-cache";
    if (parentCached === undefined) return "excluded";
    if (!sameCallerEvidence(parentCached, edge.caller)) return "invalid-cache";
    current = edge.caller;
  }
}

/**
 * Read only matching candidates for the requested page and its lookahead, and
 * return only members whose Soul evidence proves the selected caller chain.
 * Unprovable members are skipped honestly instead of reported as no more.
 */
async function verifiedCallerRows(
  candidates: readonly (KnownAkuma & Readonly<{ bound: number }>)[],
  limit: number,
  verification: CallerVerification,
): Promise<Readonly<{ rows: readonly AkumaListRowValue[]; skipped: number; invalid: boolean }>> {
  const included: AkumaListRowValue[] = [];
  let skipped = 0;
  let cursor = 0;
  while (cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + PAGE_POOL_SIZE);
    const observed = await readableRows(batch);
    cursor += batch.length;
    skipped += observed.skipped;
    for (const row of observed.rows) {
      // A cache-proposed identity without a born Soul cannot justify inclusion.
      if (!("lifeAt" in row)) return { rows: included, skipped, invalid: true };
      const verdict = await verifyCallerMember(verification, row.id, row.caller);
      if (verdict === "invalid-cache") return { rows: included, skipped, invalid: true };
      if (verdict === "included") included.push(row);
      else if (verdict === "unknown") skipped += 1;
    }
    const ranked = included.sort(compareRows);
    const lookahead = ranked[limit];
    const activity = lookahead === undefined ? null : activityAt(lookahead);
    const unreadBound = candidates[cursor]?.bound;
    if (
      lookahead !== undefined &&
      activity !== null &&
      unreadBound !== undefined &&
      Number.isFinite(unreadBound) &&
      Number.isFinite(Date.parse(activity)) &&
      unreadBound < Date.parse(activity)
    ) {
      break;
    }
  }
  return { rows: included.sort(compareRows), skipped, invalid: false };
}

type CallerRosterAttempt =
  | Readonly<{
      kind: "done";
      rows: readonly AkumaListRowValue[];
      skipped: number;
      lineage: AkumaLineage;
    }>
  | Readonly<{ kind: "invalid" }>;

async function callerRosterAttempt(
  path: WorldRoot,
  limit: number,
  selected: string | undefined,
  caller: AkumaCaller,
  useCache: boolean,
): Promise<CallerRosterAttempt> {
  const known = await knownAkuma(path);
  const members = known.rows.map((row) => ({ id: row.id, paths: row.paths }));
  const lineage = useCache ? await readAkumaLineage(path, members) : await readDirectAkumaLineage(members);
  const closure = callerClosure(lineage, caller, path);
  const matching = known.rows.filter(
    (row) => closure.has(row.id) && (selected === undefined || parseAkuId(row.id).archetype === selected),
  );
  const bounded = await boundedMap(matching, async (row) => ({ ...row, bound: await mtimeBound(row.paths) }));
  const candidates = [...bounded].sort((left, right) => right.bound - left.bound);
  if (!useCache) {
    const observed = await boundedCallerRows(candidates, limit);
    return { kind: "done", rows: observed.rows, skipped: observed.skipped, lineage };
  }
  const verified = await verifiedCallerRows(candidates, limit, {
    world: path,
    root: caller,
    lineage,
    souls: new Map(),
  });
  return verified.invalid
    ? { kind: "invalid" }
    : { kind: "done", rows: verified.rows, skipped: verified.skipped, lineage };
}

/** The bounded recent-activity roster input: native membership and observed extent. */
export async function readAkumaRoster(path: WorldRoot, input: AkumaListInput = {}): Promise<AkumaList> {
  const selection = rosterInput(input, true);
  const limit = boundedListLimit(input.limit);
  return observeAkumaRoster(path, limit, selection.archetype, selection.caller);
}

/**
 * The bounded recent-activity roster: native membership, semantic order and
 * observed extent. A caller-scoped roster filters its World-local closure before
 * this same activity order and bound; World Alias context is attached above.
 */
export async function observeAkumaRoster(
  path: WorldRoot,
  limit: number,
  selected?: string,
  caller?: AkumaCaller,
): Promise<AkumaList> {
  const observedAt = new Date().toISOString();
  if (caller !== undefined) {
    const attempt = await callerRosterAttempt(path, limit, selected, caller, true);
    if (attempt.kind === "done") {
      const page = projectBoundedList(attempt.rows, limit);
      return {
        observedAt,
        // A skipped or unprovable candidate leaves the extent unknowable, never empty.
        hasMore: page.hasMore || attempt.skipped > 0,
        rows: page.rows,
        searched: [akumaRunRoot(path)],
      };
    }
    // One wrong edge makes the whole disposable record untrustworthy.
    await invalidateAkumaLineage(path);
    const repaired = await callerRosterAttempt(path, limit, selected, caller, false);
    if (repaired.kind === "invalid") throw new Error("direct caller lineage observation failed");
    await rebuildAkumaLineage(path, repaired.lineage);
    const page = projectBoundedList(repaired.rows, limit);
    return {
      observedAt,
      hasMore: page.hasMore || repaired.skipped > 0,
      rows: page.rows,
      searched: [akumaRunRoot(path)],
    };
  }
  const known = await knownAkuma(path, selected);
  const candidatesWithBounds = await boundedMap(known.rows, async (row) => ({
    ...row,
    bound: await mtimeBound(row.paths),
  }));
  const candidates = [...candidatesWithBounds].sort((left, right) => right.bound - left.bound);
  const ranked = (await boundedCallerRows(candidates, limit)).rows;
  return {
    observedAt,
    searched: [known.runRoot],
    ...projectBoundedList(ranked, limit),
  };
}

/** The complete native roster for callers whose semantics require a frozen set. */
export async function readAkumaCompleteRoster(
  path: WorldRoot,
  input: Readonly<{ archetype?: string; caller?: AkumaCaller }> = {},
): Promise<AkumaCompleteList> {
  const selection = rosterInput(input, false);
  if (selection.caller !== undefined) {
    const unfiltered = Number.POSITIVE_INFINITY;
    const attempt = await callerRosterAttempt(path, unfiltered, selection.archetype, selection.caller, true);
    if (attempt.kind === "done") {
      return {
        observedAt: new Date().toISOString(),
        rows: [...attempt.rows],
        searched: [akumaRunRoot(path)],
      };
    }
    await invalidateAkumaLineage(path);
    const repaired = await callerRosterAttempt(path, unfiltered, selection.archetype, selection.caller, false);
    if (repaired.kind === "invalid") throw new Error("direct caller lineage observation failed");
    await rebuildAkumaLineage(path, repaired.lineage);
    return { observedAt: new Date().toISOString(), rows: [...repaired.rows], searched: [akumaRunRoot(path)] };
  }
  const known = await knownAkuma(path, selection.archetype);
  return {
    observedAt: new Date().toISOString(),
    rows: [...(await readableRows(known.rows)).rows].sort(compareRows),
    searched: [known.runRoot],
  };
}

/** Internal timeline observation for composition owners. */
export async function readAkumaTimeline(path: WorldRoot, id: AkuId): Promise<AkumaStatus["timeline"]> {
  return (await new AkumaOwner(id, path).status()).timeline;
}
