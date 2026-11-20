import { KeiyakuError } from "../errors.js";
import { akumaBirthSchema, akumaCallerKey, decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { readdir } from "node:fs/promises";
import { z } from "zod";
import { projectBoundedList, lifecycleSelection, type LifecycleSelection } from "../bounded-list.js";
import { akumaLifecycle, surveillanceAudienceSchema } from "./heart/facts.js";
import type { WorldRoot } from "../world.js";
import { readBornLife, rosterListRow } from "./akuma-observe.js";
export { readAkumaWork } from "./akuma-observe.js";
import { readSoul } from "./heart/index.js";
import {
  akumaIdFromDirectoryName,
  akumaIdSchema,
  akumaPaths,
  akumaRunRoot,
  parseAkumaId,
  type AkumaId,
  type AkumaPaths,
} from "./identity.js";
import { validateAkumaName } from "../identity/normalize.js";
import { timelineItemSchema } from "./projection.js";
import { addressedWorkSchema, reportedFileChangeSchema } from "./status-projection.js";
import { boundedMap } from "./read-pool.js";

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
  selection?: LifecycleSelection;
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
    surveillants: surveillanceAudienceSchema.exactOptional(),
    lastActivityAt: z.string().exactOptional(),
    work: addressedWorkSchema,
    recent: z.array(timelineItemSchema).max(3).readonly().exactOptional(),
    changes: z.array(reportedFileChangeSchema).nonempty().readonly().exactOptional(),
    moreChanges: z.literal(true).exactOptional(),
    outsideChanges: z.number().int().positive().exactOptional(),
    strandedReason: z.literal("resume-unsupported").exactOptional(),
  })
  .strict()
  .readonly();
export type AkumaStatus = z.output<typeof akumaStatusSchema>;

const rosterLives = [...akumaStatusSchema.unwrap().shape.life.options, "unborn", "stillborn"] as const;
const activeRosterLife = z.enum(rosterLives.filter((life) => akumaLifecycle(life) === "active"));
export const activeAkumaCountsSchema = z
  .strictObject({
    total: z.number().int().nonnegative(),
    byLife: z.partialRecord(activeRosterLife, z.number().int().positive()).readonly(),
  })
  .readonly();

type ActiveAkumaCounts = z.output<typeof activeAkumaCountsSchema>;

/** Count all owner-classified active life from one strict, unscoped roster read. */
export async function countActiveAkumas(path: WorldRoot): Promise<ActiveAkumaCounts> {
  const observed = await observeRows((await knownAkuma(path)).rows, "active");
  if (observed.skipped > 0) throw new Error("Cannot classify every recognized Akuma", { cause: observed.failure });
  const byLife: Partial<Record<AkumaRosterRow["life"], number>> = {};
  for (const { life } of observed.rows) byLife[life] = (byLife[life] ?? 0) + 1;
  return { total: observed.rows.length, byLife };
}

/** One recognized Akuma directory under this World's run root. */
export type KnownAkuma = Readonly<{ id: AkumaId; paths: AkumaPaths }>;

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

/**
 * One recognized coordinate's frozen caller edge, observed directly from Soul.
 * Absence is unborn evidence and unreadability is uncertainty, never absence.
 */
type SoulEdge =
  | Readonly<{ kind: "born"; caller: AkumaCaller | null }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unreadable" }>;

async function observeSoulEdge({ id, paths }: KnownAkuma): Promise<SoulEdge> {
  try {
    const soul = await readSoul(paths);
    if (soul !== null && soul.id !== id) throw new Error("Akuma soul does not match its coordinate");
    return soul === null ? { kind: "absent" } : { kind: "born", caller: soul.caller ?? null };
  } catch {
    return { kind: "unreadable" };
  }
}

/**
 * One operation-local direct observation of every recognized caller edge. Soul
 * absence is unborn evidence, unreadability stays uncertainty, and nothing here
 * outlives the answer it serves.
 */
async function observeCallerEdges(
  members: readonly KnownAkuma[],
): Promise<Readonly<{ edges: ReadonlyMap<AkumaId, AkumaCaller | null>; unreadable: number }>> {
  const observed = await boundedMap(members, observeSoulEdge);
  const edges = new Map<AkumaId, AkumaCaller | null>();
  let unreadable = 0;
  observed.forEach((edge, index) => {
    const { id } = members[index]!;
    if (edge.kind === "born") edges.set(id, edge.caller);
    else if (edge.kind === "unreadable") unreadable += 1;
  });
  return { edges, unreadable };
}

/**
 * Read lifecycle rows for the given candidates in semantic activity order.
 * Every candidate is observed before the public bound applies: no file
 * timestamp proves semantic recency, so nothing is preordered or cut short.
 * `expectBorn` marks candidates whose Soul already proved birth in this
 * operation: an unborn-shaped lifecycle row then means the Heart was reclaimed
 * between those reads, so the row is omitted and leaves the extent uncertain
 * rather than being reported as a birth state.
 */
async function observeRows(
  rows: readonly KnownAkuma[],
  selection: LifecycleSelection,
  expectBorn = false,
): Promise<Readonly<{ rows: readonly AkumaRosterRow[]; skipped: number; failure?: unknown }>> {
  const loaded = await boundedMap(rows, async ({ id, paths }) => {
    try {
      return { row: await rosterListRow(paths, id) };
    } catch (error) {
      return { error };
    }
  });
  const readable = loaded.flatMap((item) => (item.row === undefined ? [] : [item.row]));
  const selected: AkumaRosterRow[] = [];
  let skipped = loaded.length - readable.length;
  for (const row of readable) {
    if (expectBorn && row.kind === "unborn") {
      skipped += 1;
      continue;
    }
    if (selection === "all" || akumaLifecycle(row.life) === selection) selected.push(row);
  }
  selected.sort(compareRows);
  const failed = loaded.find((item) => item.row === undefined);
  return {
    rows: selected,
    skipped,
    ...(failed === undefined ? {} : { failure: failed.error }),
  };
}

/** Exact running count requires every recognized coordinate to be readable. */
export async function countRunningAkuma(path: WorldRoot): Promise<number> {
  const observed = await observeRows((await knownAkuma(path)).rows, "all");
  if (observed.skipped > 0) throw new Error("Cannot classify every recognized Akuma", { cause: observed.failure });
  return observed.rows.filter((row) => row.life === "running").length;
}

/** Readable running subset of the same frozen caller tree used by listing. */
export async function countCallerRunningAkuma(path: WorldRoot, caller: AkumaCaller): Promise<number> {
  const known = await knownAkuma(path);
  const { edges } = await observeCallerEdges(known.rows);
  const members = callerClosure(edges, caller, path);
  const running = await boundedMap(
    known.rows.filter(({ id }) => members.has(id)),
    async ({ id, paths }) => {
      try {
        return (await readBornLife(paths, id)) === "running" ? 1 : 0;
      } catch {
        // Failed life does not erase the already proven Soul edge for descendants.
        return 0;
      }
    },
  );
  return running.reduce<number>((count, value) => count + value, 0);
}

export function rosterInput(
  input: AkumaRosterInput | Readonly<{ akumaName?: string }>,
  allowLimit: boolean,
): Readonly<{ akumaName?: string; caller?: AkumaCaller; selection?: LifecycleSelection }> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new KeiyakuError("invalid-input", "Akuma list input must be an object");
  const allowed = allowLimit ? ["akumaName", "caller", "selection", "limit"] : ["akumaName", "caller"];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new KeiyakuError("invalid-input", `Akuma list input has unknown field: ${unknown}`);
  const caller = decodeAkumaCaller((input as AkumaRosterInput).caller);
  return {
    ...(input.akumaName === undefined ? {} : { akumaName: validateAkumaName(input.akumaName) }),
    ...(caller === undefined ? {} : { caller }),
    ...(allowLimit ? { selection: lifecycleSelection((input as AkumaRosterInput).selection) } : {}),
  };
}

/**
 * The caller closure follows only frozen Soul edges: the exact root coordinate,
 * then Akuma coordinates inside this selected World. Fork origin is not an edge.
 * Known identities deduplicate repeated and cyclic edges.
 */
function callerClosure(
  lineage: ReadonlyMap<AkumaId, AkumaCaller | null>,
  root: AkumaCaller,
  world: WorldRoot,
): ReadonlySet<AkumaId> {
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
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const caller = queue[cursor]!;
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

/**
 * The caller closure across every Akuma name, before the requested one narrows
 * it. Only proven Soul edges join the tree; an unreadable recognized identity
 * stays separate uncertainty rather than guessed membership.
 */
async function callerCandidates(
  rows: readonly KnownAkuma[],
  root: AkumaCaller,
  world: WorldRoot,
  selected: string | undefined,
): Promise<Readonly<{ rows: readonly KnownAkuma[]; unreadable: number }>> {
  const { edges, unreadable } = await observeCallerEdges(rows);
  const closure = callerClosure(edges, root, world);
  return {
    unreadable,
    rows: rows.filter(
      (row) => closure.has(row.id) && (selected === undefined || parseAkumaId(row.id).akumaName === selected),
    ),
  };
}

/**
 * One caller-scoped answer from the same direct Soul evidence the running count
 * uses. A failed lifecycle read never erases a proven Soul edge, and unreadable
 * Souls leave honest extent uncertainty instead of an empty success.
 */
async function readCallerPage(
  path: WorldRoot,
  caller: AkumaCaller,
  selected: string | undefined,
  selection: LifecycleSelection = "all",
): Promise<Readonly<{ rows: readonly AkumaRosterRow[]; skipped: number }>> {
  const known = await knownAkuma(path);
  const candidates = await callerCandidates(known.rows, caller, path, selected);
  const observed = await observeRows(candidates.rows, selection, true);
  return { rows: observed.rows, skipped: observed.skipped + candidates.unreadable };
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
  selection: LifecycleSelection = "all",
): Promise<AkumaRosterPage> {
  const observedAt = new Date().toISOString();
  if (caller !== undefined) {
    const page = await readCallerPage(path, caller, selected, selection);
    const bounded = projectBoundedList(page.rows, limit);
    return rosterResult(observedAt, bounded.rows, bounded.hasMore || page.skipped > 0);
  }
  const known = await knownAkuma(path, selected);
  const observed = await observeRows(known.rows, selection);
  const bounded = projectBoundedList(observed.rows, limit);
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
    const page = await readCallerPage(path, selection.caller, selection.akumaName);
    return { kind: "akumas", observedAt, rows: page.rows };
  }
  const known = await knownAkuma(path, selection.akumaName);
  return {
    kind: "akumas",
    observedAt,
    rows: (await observeRows(known.rows, "all")).rows,
  };
}
