import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { boundedListLimit, projectBoundedList } from "../bounded-list.js";
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
import { callReadonly, canonicalBirthCwd } from "./call-input.js";
import { fleetListRow, readAkumaBirthCwd } from "./akuma-observe.js";
import { akuIdFromDirectoryName, akumaPaths, akumaRunRoot, archetypeName, parseAkuId } from "./identity.js";
import { loadArchetype, listArchetypes as readArchetypes } from "./archetype.js";
import { birthAkuma, launchAkuma } from "./publication.js";
import { spawnAkumaBody } from "./body.js";
import { requestForwardedAkumaCall } from "./call-request.js";
import { executionChannel } from "./requests.js";
import { decodeAllowedActions, unionAllowedActions } from "./allowed.js";
import { settings as readSettings } from "../settings.js";
import { schemaJsonText } from "./schema.js";
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
  initialBody?: string;
  initialSchemaJson?: string;
  execution: BornExecution;
}>;

export type RequestedAkumaCall = Readonly<{
  kind: "requested";
  id: AllocatedAkuma["id"];
  cwd: string;
  execution: BornExecution;
}>;

export type AkumaBornCall = BornAkumaCall | RequestedAkumaCall;

type AkumaCallLaunchInput = Omit<AkumaCallInput, "body"> & Readonly<{ body?: string }>;
type AkumaListRowValue = AkumaListRow | UnbornAkumaListRow;
type KnownAkuma = Readonly<{
  id: ReturnType<typeof akuIdFromDirectoryName>["id"];
  paths: ReturnType<typeof akumaPaths>;
}>;

async function admitBodyRequest(input: {
  call: AkumaCallLaunchInput;
  context: AkumaCallContext;
  path: WorldRoot;
  name: string;
  recipe: AkumaCallRecipe;
  execution: Extract<ReturnType<typeof executionChannel>, { kind: "body-request" }>;
}): Promise<RequestedAkumaCall> {
  const cwd =
    input.call.cwd === undefined
      ? undefined
      : input.context.cwdCanonical === true
        ? input.call.cwd
        : await canonicalBirthCwd(input.call.cwd);
  const child = await requestForwardedAkumaCall({
    directory: input.execution.directory,
    id: randomUUID(),
    world: input.path,
    archetype: input.name,
    ...(input.call.body === undefined ? {} : { body: input.call.body }),
    ...(cwd === undefined ? {} : { cwd }),
    recipe: input.recipe,
  });
  const bornCwd = await readAkumaBirthCwd(input.path, child);
  return {
    kind: "requested",
    id: child,
    cwd: bornCwd,
    execution: { cwd: bornCwd, source: cwd === undefined ? "caller" : "input" },
  };
}

async function admitDirect(input: {
  call: AkumaCallLaunchInput;
  context: AkumaCallContext;
  path: WorldRoot;
  archetype: Awaited<ReturnType<typeof loadArchetype>>;
  recipe: AkumaCallRecipe;
}): Promise<BornAkumaCall> {
  const initiatorCwd = input.context.initiatorCwd;
  const selectedCwd = input.call.cwd ?? initiatorCwd ?? input.path;
  const cwd =
    input.call.cwd !== undefined && input.context.cwdCanonical === true
      ? input.call.cwd
      : await canonicalBirthCwd(selectedCwd);
  const allocated = await birthAkuma({ worldPath: input.path, archetype: input.archetype.name });
  return {
    kind: "born",
    allocated,
    seed: {
      id: allocated.id,
      archetype: allocated.archetype,
      ...input.recipe,
      cwd,
      origin: { kind: "direct" },
    },
    ...(input.call.body === undefined ? {} : { initialBody: input.call.body }),
    ...(input.call.schema === undefined ? {} : { initialSchemaJson: schemaJsonText(input.call.schema) }),
    execution: {
      cwd,
      source: input.call.cwd !== undefined ? "input" : initiatorCwd === undefined ? "world" : "process",
    },
  };
}

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

class AkumaProduct {
  private constructor(
    private readonly path: WorldRoot,
    private readonly configuration: AkumaConfiguration,
  ) {}
  static create(root: WorldRoot, input: AkumaConfiguration = {}): AkumaProduct {
    if (typeof root !== "string") throw new TypeError("Akuma product root must be a WorldRoot");
    return new AkumaProduct(root, input);
  }
  selectHandle(input: Readonly<{ id: string }>): AkumaHandle {
    return new AkumaHandle(parseAkuId(input.id).id, this.path);
  }
  async listArchetypes(): Promise<readonly string[]> {
    return readArchetypes({
      project: this.path,
      ...(this.configuration.home === undefined ? {} : { home: this.configuration.home }),
    });
  }
  async invoke(input: AkumaCallLaunchInput): Promise<AkumaHandle> {
    return await this[CALL_WITH_CONTEXT](input, { initiatorCwd: process.cwd() });
  }
  async admit(input: AkumaCallLaunchInput, context: AkumaCallContext): Promise<AkumaBornCall> {
    const readonly = callReadonly(input.readonly);
    const name = archetypeName(input.archetype);
    const home = this.configuration.home === undefined ? {} : { home: this.configuration.home };
    const settings = this.configuration.settings ?? (await readSettings({ root: this.path, ...home }));
    const archetype = await loadArchetype({ name, project: this.path, ...home, settings, ...readonly });
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
    if (execution.kind === "body-request")
      return await admitBodyRequest({ call: input, context, path: this.path, name, recipe: requestRecipe, execution });
    return await admitDirect({ call: input, context, path: this.path, archetype, recipe: requestRecipe });
  }
  async publish(born: AkumaBornCall, completion: Readonly<{ contractId?: string }> = {}): Promise<AkumaHandle> {
    if (born.kind === "requested") {
      return new AkumaHandle(born.id, this.path, { cwd: born.cwd, source: born.execution.source });
    }
    const published = await launchAkuma({
      allocated: born.allocated,
      launch: async (allocated) =>
        await spawnAkumaBody({
          paths: allocated.paths,
          seed: born.seed,
          ...(born.initialBody === undefined ? {} : { initialBody: born.initialBody }),
          ...(born.initialSchemaJson === undefined ? {} : { initialSchemaJson: born.initialSchemaJson }),
          ...(Object.keys(completion).length === 0 ? {} : { completion }),
        }),
    });
    return new AkumaHandle(published.id, this.path, {
      cwd: born.execution.cwd,
      source: born.execution.source,
    });
  }
  async [CALL_WITH_CONTEXT](input: AkumaCallLaunchInput, context: AkumaCallContext): Promise<AkumaHandle> {
    return await this.publish(await this.admit(input, context));
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
    const limit = boundedListLimit(input.limit);
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
      searched: [known.runRoot],
      ...projectBoundedList(ranked, limit),
    };
  }
}

/** Internal composition product; the package exposes the smaller Akuma instance instead. */
export function createAkumaProduct(root: WorldRoot, input: AkumaConfiguration = {}): AkumaProduct {
  return AkumaProduct.create(root, input);
}
