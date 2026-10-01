import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";
import { rosterListRow } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import { allowedActionsSchema } from "./allowed.js";
import { listArchetypes as readArchetypes } from "./archetype.js";
import type { AkumaLife } from "./heart/index.js";
import {
  akuIdFromDirectoryName,
  akumaIdSchema,
  akumaPaths,
  akumaRunRoot,
  archetypeName,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
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
  limit?: number;
}>;

export const akumaStatusSchema = z
  .object({
    id: akumaIdSchema,
    life: z.enum(["running", "asleep", "stranded", "hung", "untidy", "killed"]),
    cwd: z.string().optional(),
    allowed: allowedActionsSchema,
    timeline: activitySnapshotSchema,
    strandedReason: z.literal("resume-unsupported").optional(),
  })
  .strict();
export type AkumaStatus = z.infer<typeof akumaStatusSchema>;

export function parseAkumaStatus(value: unknown): AkumaStatus {
  return akumaStatusSchema.parse(value);
}

export async function listAkumaArchetypes(
  path: WorldRoot,
  input: Readonly<{ home?: string }> = {},
): Promise<readonly string[]> {
  return readArchetypes({ project: path, ...(input.home === undefined ? {} : { home: input.home }) });
}

type AkumaListRowValue = AkumaListRow | UnbornAkumaListRow;
type KnownAkuma = Readonly<{
  id: ReturnType<typeof akuIdFromDirectoryName>["id"];
  paths: ReturnType<typeof akumaPaths>;
}>;

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

async function knownAkuma(
  path: WorldRoot,
  selected: string | undefined,
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

async function readableRows(rows: readonly KnownAkuma[]): Promise<readonly AkumaListRowValue[]> {
  const loaded = await boundedMap(rows, async ({ id, paths }) => {
    try {
      return await rosterListRow(paths, id);
    } catch {
      return null;
    }
  });
  return [...loaded].filter((row): row is AkumaListRowValue => row !== null);
}

function rosterArchetype(
  input: AkumaListInput | Readonly<{ archetype?: string }>,
  allowLimit: boolean,
): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new TypeError("Akuma list input must be an object");
  const allowed = allowLimit ? ["archetype", "limit"] : ["archetype"];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new TypeError(`Akuma list input has unknown field: ${unknown}`);
  return input.archetype === undefined ? undefined : archetypeName(input.archetype);
}

/**
 * The bounded recent-activity roster: native membership, semantic order and
 * observed extent. World Alias context is attached by the upper composition.
 */
export async function readAkumaRoster(path: WorldRoot, input: AkumaListInput = {}): Promise<AkumaList> {
  const selected = rosterArchetype(input, true);
  const limit = boundedListLimit((input as AkumaListInput).limit);
  const observedAt = new Date().toISOString();
  const known = await knownAkuma(path, selected);
  const candidatesWithBounds = await boundedMap(known.rows, async (row) => ({
    ...row,
    bound: await mtimeBound(row.paths),
  }));
  const candidates = [...candidatesWithBounds].sort((left, right) => right.bound - left.bound);
  const readable: AkumaListRowValue[] = [];
  let cursor = 0;
  while (cursor < candidates.length) {
    const batch = candidates.slice(cursor, cursor + PAGE_POOL_SIZE);
    readable.push(...(await readableRows(batch)));
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
  const ranked = readable.sort(compareRows);
  return {
    observedAt,
    searched: [known.runRoot],
    ...projectBoundedList(ranked, limit),
  };
}

/** The complete native roster for callers whose semantics require a frozen set. */
export async function readAkumaCompleteRoster(
  path: WorldRoot,
  input: Readonly<{ archetype?: string }> = {},
): Promise<AkumaCompleteList> {
  const selected = rosterArchetype(input, false);
  const known = await knownAkuma(path, selected);
  return {
    observedAt: new Date().toISOString(),
    rows: [...(await readableRows(known.rows))].sort(compareRows),
    searched: [known.runRoot],
  };
}

/** Internal timeline observation for composition owners. */
export async function readAkumaTimeline(path: WorldRoot, id: AkuId): Promise<AkumaStatus["timeline"]> {
  return (await new AkumaOwner(id, path).status()).timeline;
}
