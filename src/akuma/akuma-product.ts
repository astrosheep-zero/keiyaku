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
import { canonicalBirthCwd } from "./call-input.js";
import type { CallInitialTell, TellResult } from "./call-initial-tell.js";
import { rosterListRow, readAkumaBirthCwd } from "./akuma-observe.js";
import { readAliases, type AliasBinding } from "../alias/index.js";
import type { AkumaAlias } from "../identity/selector.js";
import { akuIdFromDirectoryName, akumaPaths, akumaRunRoot, archetypeName, parseAkuId } from "./identity.js";
import { AkumaArchetypeError, loadPreparedArchetype, listArchetypes as readArchetypes } from "./archetype.js";
import { executePreparedCall, PreparedCallAdmissionError } from "./publication.js";
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

export type InitialCallTell = CallInitialTell;

/** One admitted call: the leading child identity plus the exact live initial Tell evidence when supplied. */
export type AdmittedAkumaCall = Readonly<{
  id: AllocatedAkuma["id"];
  cwd: string;
  execution: BornExecution;
  /** True when the serving process was reached through the one direct-parent request channel. */
  requested: boolean;
  tell?: TellResult;
  /** The native local failure, or the request transport's diagnostic text, after a confirmed birth. */
  failure?: unknown;
}>;

type AkumaCallLaunchInput = Omit<AkumaCallInput, "body" | "schema"> &
  Readonly<{ initialTell?: InitialCallTell; contractId?: string }>;
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
}): Promise<AdmittedAkumaCall> {
  const cwd =
    input.call.cwd === undefined
      ? undefined
      : input.context.cwdCanonical === true
        ? input.call.cwd
        : await canonicalBirthCwd(input.call.cwd);
  const response = await requestForwardedAkumaCall({
    directory: input.execution.directory,
    id: randomUUID(),
    world: input.path,
    archetype: input.name,
    ...(input.call.initialTell === undefined ? {} : { initialTell: input.call.initialTell }),
    ...(cwd === undefined ? {} : { cwd }),
    recipe: input.recipe,
    ...(input.call.signal === undefined ? {} : { signal: input.call.signal }),
  });
  const bornCwd = await readAkumaBirthCwd(input.path, response.id);
  return {
    id: response.id,
    cwd: bornCwd,
    requested: true,
    execution: { cwd: bornCwd, source: cwd === undefined ? "caller" : "input" },
    ...(response.kind === "live" && response.tell !== undefined ? { tell: response.tell } : {}),
    ...(response.kind === "live" && response.tellFailure !== undefined ? { failure: response.tellFailure } : {}),
    ...(response.kind === "reference" && input.call.initialTell !== undefined
      ? { failure: `Akuma ${response.id} was born without its exact initial Tell receipt` }
      : {}),
  };
}

async function admitDirect(input: {
  call: AkumaCallLaunchInput;
  context: AkumaCallContext;
  path: WorldRoot;
  archetype: Awaited<ReturnType<typeof loadPreparedArchetype>>;
  recipe: AkumaCallRecipe;
}): Promise<AdmittedAkumaCall> {
  const initiatorCwd = input.context.initiatorCwd;
  const selectedCwd = input.call.cwd ?? initiatorCwd ?? input.path;
  const cwd =
    input.call.cwd !== undefined && input.context.cwdCanonical === true
      ? input.call.cwd
      : await canonicalBirthCwd(selectedCwd);
  let result: Awaited<ReturnType<typeof executePreparedCall>>;
  try {
    result = await executePreparedCall({
      archetype: input.archetype.name,
      cwd,
      ...(input.call.initialTell === undefined ? {} : { initialTell: input.call.initialTell }),
      ...(input.call.signal === undefined ? {} : { signal: input.call.signal }),
      custody: {
        kind: "local",
        world: input.path,
        recipe: input.recipe,
        spawn: async (launch) =>
          await spawnAkumaBody({
            paths: launch.paths,
            seed: launch.seed,
            ...(input.call.contractId === undefined ? {} : { completion: { contractId: input.call.contractId } }),
          }),
        admitInitialTell: async ({ id, initialTell, signal }) =>
          await new AkumaHandle(id, input.path).admitInitialTell(initialTell, {
            ...(signal === undefined ? {} : { signal }),
          }),
      },
    });
  } catch (error) {
    // The executor owns provider admission; this local edge restores the
    // Archetype-classified refusal the initiating caller has always seen.
    if (error instanceof PreparedCallAdmissionError) {
      throw new AkumaArchetypeError(
        input.archetype.name,
        [input.archetype.path],
        error.stage === "options" ? `is unsupported: ${error.diagnostic}` : `uses ${error.diagnostic}`,
      );
    }
    throw error;
  }
  return {
    id: result.child.id,
    cwd,
    requested: false,
    execution: {
      cwd,
      source: input.call.cwd !== undefined ? "input" : initiatorCwd === undefined ? "world" : "process",
    },
    ...(result.tell === undefined ? {} : { tell: result.tell }),
    ...(result.failure === undefined ? {} : { failure: result.failure }),
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

async function readableRows(
  rows: readonly KnownAkuma[],
  aliases: ReadonlyMap<string, readonly AkumaAlias[]>,
): Promise<readonly AkumaListRowValue[]> {
  const loaded = await boundedMap(rows, async ({ id, paths }) => {
    try {
      return await rosterListRow(paths, id, aliases.get(id) ?? []);
    } catch {
      return null;
    }
  });
  return [...loaded].filter((row): row is AkumaListRowValue => row !== null);
}

function aliasesByAku(bindings: readonly AliasBinding[]): ReadonlyMap<string, readonly AkumaAlias[]> {
  const byId = new Map<string, AkumaAlias[]>();
  for (const binding of bindings) {
    const aliases = byId.get(binding.akuId) ?? [];
    aliases.push(binding.alias);
    byId.set(binding.akuId, aliases);
  }
  return byId;
}

async function readAliasesByAku(world: WorldRoot): Promise<ReadonlyMap<string, readonly AkumaAlias[]>> {
  return aliasesByAku(await readAliases(world));
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
  async admit(input: AkumaCallLaunchInput, context: AkumaCallContext): Promise<AdmittedAkumaCall> {
    const name = archetypeName(input.archetype);
    const home = this.configuration.home === undefined ? {} : { home: this.configuration.home };
    const settings = this.configuration.settings ?? (await readSettings({ root: this.path, ...home }));
    const archetype = await loadPreparedArchetype({ name, project: this.path, ...home, settings });
    const allowed =
      input.allowed === undefined
        ? archetype.allowed
        : unionAllowedActions(archetype.allowed, decodeAllowedActions(input.allowed, "Akuma call allowed"));
    const execution = executionChannel(this.configuration.execution);
    const requestRecipe = Object.freeze({
      ...(archetype.description === undefined ? {} : { description: archetype.description }),
      provider: archetype.provider,
      options: archetype.options,
      allowed,
    });
    if (execution.kind === "body-request")
      return await admitBodyRequest({ call: input, context, path: this.path, name, recipe: requestRecipe, execution });
    return await admitDirect({ call: input, context, path: this.path, archetype, recipe: requestRecipe });
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
      rows: [...(await readableRows(known.rows, await readAliasesByAku(this.path)))].sort(compareRows),
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
    const aliases = await readAliasesByAku(this.path);
    const readable: AkumaListRowValue[] = [];
    let cursor = 0;
    while (cursor < candidates.length) {
      const batch = candidates.slice(cursor, cursor + PAGE_POOL_SIZE);
      readable.push(...(await readableRows(batch, aliases)));
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
