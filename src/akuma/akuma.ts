import { akumaBirthSchema, akumaCallerKey, decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { projectBoundedList } from "../bounded-list.js";
import type { WorldRoot } from "../world.js";
import { rosterListRow } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import { readSoul } from "./heart/index.js";
import {
  akumaIdFromDirectoryName,
  akumaIdSchema,
  akumaPaths,
  akumaRunRoot,
  parseAkumaId,
  pathsForAkumaId,
  type AkumaId,
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
import type { ActivitySnapshot } from "./projection.js";
import { currentWorkSchema } from "./status-projection.js";
import { PAGE_POOL_SIZE, boundedMap } from "./read-pool.js";

type BornLife = AkumaStatus["life"];

/** The lower owner's native roster row; public listing projects it. */
export type AkumaRosterRow =
  | Readonly<{
      kind: "born";
      id: AkumaId;
      life: BornLife;
      lifeAt?: string;
      lastActivityAt?: string;
      pending?: number;
      caller?: AkumaCaller;
    }>
  | Readonly<{
      kind: "unborn";
      id: AkumaId;
      life: "unborn" | "stillborn";
      diagnostic?: string;
    }>;
export type AkumaRosterPage = Readonly<{
  observedAt: string;
  rows?: readonly AkumaRosterRow[];
  more?: true;
}>;
/** The advanced complete roster: every recognized member and known completeness. */
export type AkumaCompleteList = Readonly<{
  kind: "akumas";
  observedAt: string;
  rows: readonly AkumaRosterRow[];
}>;

export type AkumaRosterInput = Readonly<{
  akumaName?: string;
  caller?: AkumaCaller;
  limit?: number;
}>;

export const akumaStatusSchema = z
  .object({
    id: akumaIdSchema,
    birth: akumaBirthSchema,
    life: z.enum(["running", "asleep", "stranded", "hung", "untidy", "killed"]),
    cwd: z.string().exactOptional(),
    provider: z.string().exactOptional(),
    model: z.string().exactOptional(),
    lastActivityAt: z.string().exactOptional(),
    work: currentWorkSchema,
    strandedReason: z.literal("resume-unsupported").exactOptional(),
  })
  .strict()
  .readonly();
export type AkumaStatus = z.output<typeof akumaStatusSchema>;

/** One recognized Akuma directory under this World's run root. */
export type KnownAkuma = Readonly<{ id: AkumaId; paths: AkumaPaths }>;

type ActivityCandidate = KnownAkuma & Readonly<{ bound: number }>;

function activityAt(row: AkumaRosterRow): string | null {
  if (row.kind === "unborn") return null;
  const lifeAt = row.lifeAt ?? null;
  const lastActivityAt = row.lastActivityAt ?? null;
  if (lifeAt === null) return lastActivityAt;
  if (lastActivityAt === null) return lifeAt;
  return lifeAt > lastActivityAt ? lifeAt : lastActivityAt;
}

function compareActivity(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left > right ? -1 : 1;
}

function compareRows(left: AkumaRosterRow, right: AkumaRosterRow): number {
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
    let physical: ReturnType<typeof akumaIdFromDirectoryName>;
    try {
      physical = akumaIdFromDirectoryName(name);
    } catch {
      // The run root can contain bytes not produced by Keiyaku. Preserve them.
      continue;
    }
    if (selected !== undefined && physical.akumaName !== selected) continue;
    rows.push({
      id: physical.id,
      paths: akumaPaths({ runRoot, akumaName: physical.akumaName, suffix: physical.suffix }),
    });
  }
  return { runRoot, rows };
}

/** Preorder candidates by their freshest Heart mtime so paging reads changed rows first. */
async function freshnessOrdered(rows: readonly KnownAkuma[]): Promise<readonly ActivityCandidate[]> {
  const bounded = await boundedMap(rows, async (row) => ({ ...row, bound: await mtimeBound(row.paths) }));
  return [...bounded].sort((left, right) => right.bound - left.bound);
}

async function readableRows(
  rows: readonly KnownAkuma[],
): Promise<Readonly<{ rows: readonly AkumaRosterRow[]; skipped: number; failure?: unknown }>> {
  const loaded = await boundedMap(rows, async ({ id, paths }) => {
    try {
      return { row: await rosterListRow(paths, id) };
    } catch (error) {
      return { error };
    }
  });
  const values = loaded.flatMap((item) => (item.row === undefined ? [] : [item.row]));
  const failed = loaded.find((item) => item.row === undefined);
  return {
    rows: values,
    skipped: loaded.length - values.length,
    ...(failed === undefined ? {} : { failure: failed.error }),
  };
}

/** Exact running count requires every recognized coordinate to be readable. */
export async function countRunningAkuma(path: WorldRoot): Promise<number> {
  const observed = await readableRows((await knownAkuma(path)).rows);
  if (observed.skipped > 0) throw new Error("Cannot classify every recognized Akuma", { cause: observed.failure });
  return observed.rows.filter((row) => row.life === "running").length;
}

export function rosterInput(
  input: AkumaRosterInput | Readonly<{ akumaName?: string }>,
  allowLimit: boolean,
): Readonly<{ akumaName?: string; caller?: AkumaCaller }> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("Akuma list input must be an object");
  const allowed = allowLimit ? ["akumaName", "caller", "limit"] : ["akumaName", "caller"];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Akuma list input has unknown field: ${unknown}`);
  const caller = decodeAkumaCaller((input as AkumaRosterInput).caller);
  return {
    ...(input.akumaName === undefined ? {} : { akumaName: validateAkumaName(input.akumaName) }),
    ...(caller === undefined ? {} : { caller }),
  };
}

/**
 * The caller closure follows only frozen Soul edges: the exact root coordinate,
 * then Akuma coordinates inside this selected World. Fork origin is not an edge.
 * Known identities deduplicate repeated and cyclic edges.
 */
function callerClosure(lineage: AkumaLineage, root: AkumaCaller, world: WorldRoot): ReadonlySet<AkumaId> {
  if (root.kind === "akuma" && root.world !== world) return new Set();
  const children = new Map<string, AkumaId[]>();
  for (const [akumaId, caller] of lineage) {
    if (caller === null) continue;
    const key = akumaCallerKey(caller);
    const siblings = children.get(key);
    if (siblings === undefined) children.set(key, [akumaId]);
    else siblings.push(akumaId);
  }
  const included = new Set<AkumaId>();
  const visited = new Set<string>();
  const queue: AkumaCaller[] = [root];
  while (queue.length > 0) {
    const caller = queue.shift()!;
    const key = akumaCallerKey(caller);
    if (visited.has(key)) continue;
    visited.add(key);
    for (const akumaId of children.get(key) ?? []) {
      if (included.has(akumaId)) continue;
      included.add(akumaId);
      queue.push({ kind: "akuma", world, akumaId });
    }
  }
  return included;
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

async function readCallerSoul(world: WorldRoot, akumaId: AkumaId): Promise<SoulEdge> {
  try {
    const soul = await readSoul(pathsForAkumaId(world, akumaId));
    return soul === null ? { kind: "absent" } : { kind: "born", caller: soul.caller ?? null };
  } catch {
    return { kind: "unreadable" };
  }
}

type CallerVerification = Readonly<{
  world: WorldRoot;
  root: AkumaCaller;
  lineage: AkumaLineage;
  souls: Map<AkumaId, Promise<SoulEdge>>;
}>;

async function soulEdgeFor(verification: CallerVerification, akumaId: AkumaId): Promise<SoulEdge> {
  const observed = verification.souls.get(akumaId);
  if (observed !== undefined) return await observed;
  const pending = readCallerSoul(verification.world, akumaId);
  verification.souls.set(akumaId, pending);
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
  id: AkumaId,
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
    const parentId = current.akumaId;
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

type CallerPage = Readonly<{ rows: readonly AkumaRosterRow[]; skipped: number; invalid: boolean }>;

/**
 * Read only the matching candidates needed for the requested page and its
 * lookahead. `admit` proves each readable member; without it the selected
 * closure's own born Soul edges are the proof. Unprovable members are skipped
 * honestly instead of reported as no more.
 */
async function pageCallerRows(
  candidates: readonly ActivityCandidate[],
  limit: number,
  admit?: (row: AkumaRosterRow) => Promise<MemberVerdict>,
): Promise<CallerPage> {
  const rows: AkumaRosterRow[] = [];
  let skipped = 0;
  let cursor = 0;
  while (cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + PAGE_POOL_SIZE);
    const observed = await readableRows(batch);
    cursor += batch.length;
    skipped += observed.skipped;
    for (const row of observed.rows) {
      const verdict = admit === undefined ? "included" : await admit(row);
      if (verdict === "invalid-cache") return { rows, skipped, invalid: true };
      if (verdict === "included") rows.push(row);
      else if (verdict === "unknown") skipped += 1;
    }
    rows.sort(compareRows);
    const lookahead = rows[limit];
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
  return { rows: rows.sort(compareRows), skipped, invalid: false };
}

/**
 * The caller closure across every Archetype, before the requested one narrows
 * it, ordered so paging reads freshly changed members first.
 */
async function callerCandidates(
  rows: readonly KnownAkuma[],
  lineage: AkumaLineage,
  root: AkumaCaller,
  world: WorldRoot,
  selected: string | undefined,
): Promise<readonly ActivityCandidate[]> {
  const closure = callerClosure(lineage, root, world);
  return await freshnessOrdered(
    rows.filter(
      (row) => closure.has(row.id) && (selected === undefined || parseAkumaId(row.id).akumaName === selected),
    ),
  );
}

/**
 * One caller-scoped page. The World-local record only proposes members: each is
 * re-proven against its born Soul chain, and one disagreement discards the
 * record and answers from direct Soul evidence instead of an empty success.
 */
async function readCallerPage(
  path: WorldRoot,
  limit: number,
  selected: string | undefined,
  caller: AkumaCaller,
): Promise<CallerPage> {
  const known = await knownAkuma(path);
  const cached = await readAkumaLineage(path, known.rows);
  const verification: CallerVerification = { world: path, root: caller, lineage: cached, souls: new Map() };
  const attempted = await pageCallerRows(
    await callerCandidates(known.rows, cached, caller, path, selected),
    limit,
    // A cache-proposed identity without a born Soul cannot justify inclusion.
    async (row) => (row.kind === "born" ? await verifyCallerMember(verification, row.id, row.caller) : "invalid-cache"),
  );
  if (!attempted.invalid) return attempted;
  // One wrong edge makes the whole disposable record untrustworthy.
  await invalidateAkumaLineage(path);
  const direct = await readDirectAkumaLineage(known.rows);
  const repaired = await pageCallerRows(await callerCandidates(known.rows, direct, caller, path, selected), limit);
  await rebuildAkumaLineage(path, direct);
  return repaired;
}

/** One roster answer: empty rows and known completeness are both omissions. */
function rosterResult(observedAt: string, rows: readonly AkumaRosterRow[], more: boolean): AkumaRosterPage {
  return {
    observedAt,
    ...(rows.length === 0 ? {} : { rows }),
    ...(more ? { more: true as const } : {}),
  };
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
): Promise<AkumaRosterPage> {
  const observedAt = new Date().toISOString();
  if (caller !== undefined) {
    const page = await readCallerPage(path, limit, selected, caller);
    const bounded = projectBoundedList(page.rows, limit);
    return rosterResult(observedAt, bounded.rows, bounded.hasMore || page.skipped > 0);
  }
  const known = await knownAkuma(path, selected);
  const ranked = await pageCallerRows(await freshnessOrdered(known.rows), limit);
  const bounded = projectBoundedList(ranked.rows, limit);
  return rosterResult(observedAt, bounded.rows, bounded.hasMore);
}

/** The complete native roster for callers whose semantics require a frozen set. */
export async function readAkumaCompleteRoster(
  path: WorldRoot,
  input: Readonly<{ akumaName?: string; caller?: AkumaCaller }> = {},
): Promise<AkumaCompleteList> {
  const selection = rosterInput(input, false);
  const observedAt = new Date().toISOString();
  if (selection.caller !== undefined) {
    const page = await readCallerPage(path, Number.POSITIVE_INFINITY, selection.akumaName, selection.caller);
    return { kind: "akumas", observedAt, rows: page.rows };
  }
  const known = await knownAkuma(path, selection.akumaName);
  return {
    kind: "akumas",
    observedAt,
    rows: [...(await readableRows(known.rows)).rows].sort(compareRows),
  };
}

/** Internal timeline observation for composition owners. */
export async function readAkumaTimeline(path: WorldRoot, id: AkumaId): Promise<ActivitySnapshot> {
  return (await new AkumaOwner(id, path).status()).timeline;
}
