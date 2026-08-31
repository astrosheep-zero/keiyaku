import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AkumaHandle } from "./akuma-handle.js";
import type {
  AkumaCallContext,
  AkumaCallInput,
  AkumaCompleteList,
  AkumaConfiguration,
  AkumaList,
  AkumaListInput,
  AkumaListRow,
  UnbornAkumaListRow,
} from "./akuma.js";
import { CALL_WITH_CONTEXT } from "./akuma-product-symbols.js";
import { fleetListRow, readAkumaBirthCwd } from "./akuma-observe.js";
import { akuIdFromDirectoryName, akumaPaths, akumaRunRoot, archetypeName, parseAkuId } from "./identity.js";
import { loadArchetype, listArchetypes as readArchetypes } from "./archetype.js";
import { birthAkuma, launchAkuma } from "./publication.js";
import { spawnAkumaBody } from "./body.js";
import { requestForwardedAkumaCall } from "./call-request.js";
import { executionChannel } from "./requests.js";
import { decodeAllowedActions, unionAllowedActions } from "./allowed.js";
import { settings as readSettings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import type { BodyLaunch } from "./body.js";
import type { AllocatedAkuma } from "./identity.js";

type AkumaCallRecipe = Omit<NonNullable<BodyLaunch["seed"]>, "id" | "archetype" | "cwd" | "origin">;
type BornExecution = Readonly<{ cwd: string; source: "input" | "caller" | "process" | "world" }>;

export type BornAkumaCall = Readonly<{
  kind: "born";
  allocated: AllocatedAkuma;
  seed: AkumaCallRecipe &
    Readonly<{ id: AllocatedAkuma["id"]; archetype: string; cwd: string; origin: { kind: "direct" } }>;
  initialBody: string;
  execution: BornExecution;
}>;

export type RequestedAkumaCall = Readonly<{
  kind: "requested";
  id: AllocatedAkuma["id"];
  cwd: string;
  execution: BornExecution;
}>;

export type AkumaBornCall = BornAkumaCall | RequestedAkumaCall;

type AkumaCallLaunchInput = AkumaCallInput;
type AkumaListRowValue = AkumaListRow | UnbornAkumaListRow;
type KnownAkuma = Readonly<{
  id: ReturnType<typeof akuIdFromDirectoryName>["id"];
  paths: ReturnType<typeof akumaPaths>;
}>;

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 500;
export const PAGE_POOL_SIZE = 16;

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

function pageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_PAGE_LIMIT)
    throw new TypeError(`Akuma list limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  return value as number;
}

export async function boundedMap<Value, Result>(
  values: readonly Value[],
  mapper: (value: Value) => Promise<Result>,
): Promise<readonly Result[]> {
  const results: Result[] = [];
  let index = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const selected = index++;
      if (selected >= values.length) return;
      results[selected] = await mapper(values[selected]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PAGE_POOL_SIZE, values.length) }, worker));
  return results;
}

async function mtimeBound(paths: ReturnType<typeof akumaPaths>): Promise<number> {
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
      return await fleetListRow(paths, id);
    } catch {
      return null;
    }
  });
  return [...loaded].filter((row): row is AkumaListRowValue => row !== null);
}

function callReadonly(value: unknown): Readonly<{ readonly?: true }> {
  if (value === undefined) return {};
  if (value !== true) throw new TypeError("Akuma call readonly must be true");
  return { readonly: true };
}

async function canonicalBirthCwd(input: string): Promise<string> {
  const selected = resolve(input);
  try {
    const canonical = await realpath(selected);
    if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error(`cwd is not an existing directory: ${input}`);
  }
}

export class Akuma {
  private constructor(
    private readonly path: WorldRoot,
    private readonly configuration: AkumaConfiguration,
  ) {}
  static of(root: WorldRoot, input: AkumaConfiguration = {}): Akuma {
    if (typeof root !== "string") throw new TypeError("Akuma.of root must be a WorldRoot");
    return new Akuma(root, input);
  }
  of(input: Readonly<{ id: string }>): AkumaHandle {
    return new AkumaHandle(parseAkuId(input.id).id, this.path);
  }
  async listArchetypes(): Promise<readonly string[]> {
    return readArchetypes(this.configuration.home === undefined ? {} : { home: this.configuration.home });
  }
  async call(input: AkumaCallLaunchInput): Promise<AkumaHandle> {
    return await this[CALL_WITH_CONTEXT](input, { initiatorCwd: process.cwd() });
  }
  async beginCall(input: AkumaCallLaunchInput, context: AkumaCallContext): Promise<AkumaBornCall> {
    const readonly = callReadonly(input.readonly);
    const name = archetypeName(input.archetype);
    const home = this.configuration.home === undefined ? {} : { home: this.configuration.home };
    const settings = this.configuration.settings ?? (await readSettings({ root: this.path, ...home }));
    const archetype = await loadArchetype({ name, ...home, settings, ...readonly });
    const allowed =
      input.allowed === undefined
        ? archetype.allowed
        : unionAllowedActions(archetype.allowed, decodeAllowedActions(input.allowed, "Akuma call allowed"));
    const execution = executionChannel(this.configuration.execution);
    const requestRecipe = Object.freeze({
      ...(archetype.description === undefined ? {} : { description: archetype.description }),
      provider: archetype.provider,
      options: archetype.options,
      ...(archetype.readonly === undefined ? {} : { readonly: archetype.readonly }),
      allowed,
    });
    if (execution.kind === "body-request") {
      const cwd =
        input.cwd === undefined
          ? undefined
          : context?.cwdCanonical === true
            ? input.cwd
            : await canonicalBirthCwd(input.cwd);
      const child = await requestForwardedAkumaCall({
        directory: execution.directory,
        id: randomUUID(),
        world: this.path,
        archetype: name,
        body: input.body,
        ...(cwd === undefined ? {} : { cwd }),
        recipe: requestRecipe,
      });
      const bornCwd = await readAkumaBirthCwd(this.path, child);
      return {
        kind: "requested",
        id: child,
        cwd: bornCwd,
        execution: { cwd: bornCwd, source: cwd === undefined ? "caller" : "input" },
      };
    }
    const initiatorCwd = context.initiatorCwd;
    const selectedCwd = input.cwd ?? initiatorCwd ?? this.path;
    const cwd =
      input.cwd !== undefined && context?.cwdCanonical === true ? input.cwd : await canonicalBirthCwd(selectedCwd);
    const allocated = await birthAkuma({ worldPath: this.path, archetype: archetype.name });
    return {
      kind: "born",
      allocated,
      seed: {
        id: allocated.id,
        archetype: allocated.archetype,
        ...requestRecipe,
        cwd,
        origin: { kind: "direct" },
      },
      initialBody: input.body,
      execution: {
        cwd,
        source: input.cwd !== undefined ? "input" : initiatorCwd === undefined ? "world" : "process",
      },
    };
  }
  async finishCall(born: AkumaBornCall, completion: Readonly<{ contractId?: string }> = {}): Promise<AkumaHandle> {
    if (born.kind === "requested") {
      return new AkumaHandle(born.id, this.path, { cwd: born.cwd, source: born.execution.source });
    }
    const published = await launchAkuma({
      allocated: born.allocated,
      launch: async (allocated) =>
        await spawnAkumaBody({
          paths: allocated.paths,
          seed: born.seed,
          initialBody: born.initialBody,
          ...(Object.keys(completion).length === 0 ? {} : { completion }),
        }),
    });
    return new AkumaHandle(published.id, this.path, {
      cwd: born.execution.cwd,
      source: born.execution.source,
    });
  }
  async [CALL_WITH_CONTEXT](input: AkumaCallLaunchInput, context: AkumaCallContext): Promise<AkumaHandle> {
    return await this.finishCall(await this.beginCall(input, context));
  }
  async listComplete(input: Readonly<{ archetype?: string }> = {}): Promise<AkumaCompleteList> {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new TypeError("Akuma complete list input must be an object");
    const unknown = Object.keys(input).find((key) => key !== "archetype");
    if (unknown !== undefined) throw new TypeError(`Akuma complete list input has unknown field: ${unknown}`);
    const selected = input.archetype === undefined ? undefined : archetypeName(input.archetype);
    const known = await knownAkuma(this.path, selected);
    return {
      observedAt: new Date().toISOString(),
      rows: [...(await readableRows(known.rows))].sort(compareRows),
      searched: [known.runRoot],
    };
  }
  async list(input: AkumaListInput = {}): Promise<AkumaList> {
    if (typeof input !== "object" || input === null || Array.isArray(input))
      throw new TypeError("Akuma list input must be an object");
    const unknown = Object.keys(input).find((key) => key !== "archetype" && key !== "limit");
    if (unknown !== undefined) throw new TypeError(`Akuma list input has unknown field: ${unknown}`);
    const selected = input.archetype === undefined ? undefined : archetypeName(input.archetype);
    const limit = pageLimit(input.limit);
    const observedAt = new Date().toISOString();
    const known = await knownAkuma(this.path, selected);
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
      rows: ranked.slice(0, limit),
      searched: [known.runRoot],
      hasMore: ranked[limit] !== undefined,
    };
  }
}
export async function callAkumaWithContext(
  akuma: Akuma,
  input: AkumaCallLaunchInput,
  context: AkumaCallContext,
): Promise<AkumaHandle> {
  return await akuma[CALL_WITH_CONTEXT](input, context);
}

export async function beginAkumaCall(
  akuma: Akuma,
  input: AkumaCallLaunchInput,
  context: AkumaCallContext,
): Promise<AkumaBornCall> {
  return await akuma.beginCall(input, context);
}

export async function finishAkumaCall(
  akuma: Akuma,
  born: AkumaBornCall,
  completion: Readonly<{ contractId?: string }> = {},
): Promise<AkumaHandle> {
  return await akuma.finishCall(born, completion);
}
