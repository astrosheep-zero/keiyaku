import { randomUUID } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { CONTROL_RESPONSE_MS, spawnAkumaBody } from "./body.js";
import {
  HeldAkumaLeash,
  activitySlice,
  isHeartAbsent,
  life,
  lifeAt,
  probeLeash,
  readHeart,
  readLastAnsweredTurn,
  readForkPoint,
  readKill,
  readSeal,
  readSoul,
  recordTell,
  requestPause,
  requestStop,
  type AkumaLife,
  type HeartSnapshot,
  type KillEvidence,
  type ResumeCoordinate,
  type SessionFact,
  type Soul,
} from "./heart/index.js";
import {
  akuIdFromDirectoryName,
  akumaPaths,
  akumaRunRoot,
  parseAkuId,
  pathsForAkuId,
  archetypeName,
  type AkuId,
  type AkumaPaths,
} from "./identity.js";
import {
  ordinarySelectedCount,
  ordinarySnapshotBudget,
  projectTurns,
  selectActivitySnapshot,
  selectHistory,
  selectSnapshot,
  type ActivityHistory,
  type ActivitySnapshot,
} from "./projection.js";
import { listArchetypes as readArchetypes, loadArchetype } from "./archetype.js";
import { publishAkuma } from "./publication.js";
import { resolveProviderExecution } from "./providers/index.js";
import { injectedBodyRequests, requestBodyCall } from "./requests.js";
import { settings as readSettings, type Settings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import {
  decodeAllowedActions,
  type AllowedAction,
} from "./allowed.js";

const POLL_MS = 25;

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

function callReadonly(value: unknown): Readonly<{ readonly?: true }> {
  if (value === undefined) return {};
  if (value !== true) throw new TypeError("Akuma call readonly must be true");
  return { readonly: true };
}

export type AkumaListRow = Readonly<{
  id: AkuId;
  archetype: string;
  description?: string;
  life: AkumaLife;
  lifeAt: string | null;
  pending: readonly string[];
}>;

export type AkumaStatus = Readonly<{
  id: AkuId;
  life: AkumaLife;
  readonly?: Soul["readonly"];
  timeline: ActivitySnapshot;
  strandedReason?: "resume-unsupported";
}>;
export type { ReadonlyRestraint } from "./provider-recipe.js";
export type * from "./projection.js";

export type UnbornAkumaListRow = Readonly<{
  id: AkuId;
  life: "unborn" | "stillborn";
  seal?: Readonly<{ evidence: string; at: string }>;
}>;

export type AkumaList = Readonly<{
  rows: readonly (AkumaListRow | UnbornAkumaListRow)[];
  searched: readonly string[];
}>;

export type AkumaListInput = Readonly<{
  archetype?: string;
}>;

export type AkumaCallExecution = Readonly<{
  cwd: string;
  source: "input" | "caller" | "process" | "world";
}>;

const CALL_EXECUTION: unique symbol = Symbol("akuma-call-execution");
const CALL_WITH_CONTEXT: unique symbol = Symbol("akuma-call-with-context");

export type AkumaCallInput = Readonly<{
  archetype: string;
  body: string;
  cwd?: string;
  readonly?: true;
  allowed?: readonly AllowedAction[];
}>;
type AkumaCallContext = Readonly<{ initiatorCwd?: string; cwdCanonical?: true }>;

export type TellResult = Readonly<{
  admission: Readonly<{ tellId: string; fact: "recorded" }>;
  wake: "spawned" | Readonly<{ kind: "failed"; diagnostic: string }>;
}>;

export type InterruptReceipt =
  | Readonly<{
      kind: "unavailable";
      evidence: "hung" | "untidy" | "unavailable";
    }>
  | Readonly<{
      kind: "interrupted";
      putDown: "was-idle" | "self-aborted";
      tell: TellResult;
    }>;

export type ForkReceipt =
  | Readonly<{ kind: "forked"; child: AkuId }>
  | Readonly<{ kind: "provider-cannot-fork"; provider: string }>
  | Readonly<{ kind: "unknown-history"; at: string }>
  | Readonly<{ kind: "fork-failed"; diagnostic: string }>
  | Readonly<{ kind: "upstream-forked"; childSession: ResumeCoordinate; diagnostic: string }>;

export class AkumaNotBornError extends Error {
  readonly kind = "akuma-not-born";
  constructor(readonly id: AkuId) {
    super(`Akuma ${id} is not born`);
    this.name = "AkumaNotBornError";
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

async function recordTellBody(
  paths: AkumaPaths,
  akuma: AkuId,
  body: string,
  id: string = randomUUID(),
  recordedAt = new Date().toISOString(),
): Promise<Readonly<{ kind: "recorded"; tellId: string }>> {
  const admitted = await recordTell(paths, { kind: "tell", id, body, recordedAt });
  if (admitted.kind === "not-born") throw new AkumaNotBornError(akuma);
  return { kind: "recorded", tellId: admitted.tell.id };
}

async function wakeTell(paths: AkumaPaths, tellId: string): Promise<TellResult> {
  try {
    await spawnAkumaBody({ paths });
    return { admission: { tellId, fact: "recorded" }, wake: "spawned" };
  } catch (error) {
    return {
      admission: { tellId, fact: "recorded" },
      wake: { kind: "failed", diagnostic: diagnostic(error) },
    };
  }
}

export async function tellAkumaWithId(
  worldPath: WorldRoot,
  id: AkuId,
  body: string,
  tellId: string,
  recordedAt = new Date().toISOString(),
): Promise<TellResult> {
  const paths = pathsForAkuId(worldPath, id);
  const recorded = await recordTellBody(paths, id, body, tellId, recordedAt);
  return await wakeTell(paths, recorded.tellId);
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function fleetListRow(
  paths: AkumaPaths,
  expected: AkuId,
): Promise<AkumaListRow | UnbornAkumaListRow> {
  const snapshot = await readHeart(paths);
  if (snapshot.soul !== null) return await bornListRow(paths, expected, snapshot);
  try {
    if (await probeLeash(paths) === "held") return { id: expected, life: "unborn" };
    const seal = await readSeal(paths);
    return seal === null ? { id: expected, life: "unborn" } : { id: expected, life: "stillborn", seal };
  } catch (error) {
    if (isHeartAbsent(error)) return { id: expected, life: "unborn" };
    throw error;
  }
}

async function bornListRow(paths: AkumaPaths, expected: AkuId, snapshot?: HeartSnapshot): Promise<AkumaListRow> {
  snapshot ??= await readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  if (snapshot.soul.id !== expected) throw new Error("Akuma soul does not match its coordinate");
  const currentLife = life({
    leash: await probeLeash(paths),
    body: snapshot.latestBody,
    kill: snapshot.latestKill,
  });
  return {
    id: snapshot.soul.id,
    archetype: snapshot.soul.archetype,
    ...(snapshot.soul.description === undefined ? {} : { description: snapshot.soul.description }),
    life: currentLife,
    lifeAt: lifeAt(currentLife, snapshot.latestBody, snapshot.latestKill, snapshot.soul.createdAt),
    pending: snapshot.pending.map((tell) => tell.id),
  };
}

async function bornStatus(
  paths: AkumaPaths,
  expected: AkuId,
  budget?: Readonly<{ tail: number; voice: number }>,
): Promise<AkumaStatus> {
  const snapshot = await readHeart(paths);
  if (snapshot.soul === null) throw new AkumaNotBornError(expected);
  const current = await bornListRow(paths, expected, snapshot);
  const resumeUnsupported = current.life === "stranded"
    && snapshot.latestSession?.provider === snapshot.soul.provider.name
    && resolveProviderExecution(snapshot.soul.provider).adapter.resume === undefined;
  const slice = await activitySlice(paths);
  return {
    id: current.id,
    life: current.life,
    ...(snapshot.soul.readonly === undefined ? {} : { readonly: snapshot.soul.readonly }),
    ...(resumeUnsupported ? { strandedReason: "resume-unsupported" as const } : {}),
    timeline: budget === undefined
      ? selectActivitySnapshot(slice.rows)
      : selectSnapshot(projectTurns(slice.rows), budget),
  };
}

export type BudgetedStatusObservation = Readonly<{
  status: AkumaStatus;
  ordinarySelected: number;
}>;

/** Package-internal budgeted observation; Fleet allocates, Akuma still selects. */
export async function readBudgetedStatus(
  worldPath: WorldRoot,
  id: AkuId,
  input: Readonly<{ ordinaryBudget: number }>,
): Promise<BudgetedStatusObservation> {
  if (!Number.isSafeInteger(input.ordinaryBudget) || input.ordinaryBudget < 0) {
    throw new TypeError("ordinary budget must be a nonnegative safe integer");
  }
  const status = await bornStatus(
    pathsForAkuId(worldPath, id),
    id,
    ordinarySnapshotBudget(input.ordinaryBudget),
  );
  return { status, ordinarySelected: ordinarySelectedCount(status.timeline) };
}

/** Package-internal birth projection used by the composed Library call result. */
export async function readAkumaBirthCwd(worldPath: WorldRoot, id: AkuId): Promise<string> {
  const soul = await readSoul(pathsForAkuId(worldPath, id));
  if (soul === null) throw new AkumaNotBornError(id);
  return soul.cwd;
}

export class AkumaHandle {
  readonly [CALL_EXECUTION]?: AkumaCallExecution;

  constructor(
    readonly id: AkuId,
    private readonly worldPath: WorldRoot,
    execution?: AkumaCallExecution,
  ) {
    if (execution !== undefined) this[CALL_EXECUTION] = execution;
  }

  private get paths(): AkumaPaths {
    return pathsForAkuId(this.worldPath, this.id);
  }

  async status(): Promise<AkumaStatus> {
    return await bornStatus(this.paths, this.id);
  }

  async history(input: Readonly<{ before?: number; since?: number; limit?: number }> = {}): Promise<ActivityHistory> {
    if (input.before !== undefined && input.since !== undefined) {
      throw new TypeError("Akuma history before and since are mutually exclusive");
    }
    for (const [name, value] of [["before", input.before], ["since", input.since]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(`Akuma history ${name} must be a positive safe integer`);
      }
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5_000) {
      throw new TypeError("Akuma history limit must be a positive safe integer no greater than 5000");
    }
    const slice = await activitySlice(this.paths);
    return selectHistory(projectTurns(slice.rows, {
      lowestRetained: slice.lowestRetained,
      highest: slice.highest,
    }), {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit,
    });
  }

  async wait(
    predicate: (status: AkumaStatus) => boolean = (status) => status.life !== "running",
    options: Readonly<{ timeoutMs?: number }> = {},
  ): Promise<AkumaStatus> {
    if (options.timeoutMs !== undefined
      && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError("Akuma wait timeoutMs must be a nonnegative finite millisecond duration");
    }
    const deadline = options.timeoutMs === undefined ? undefined : performance.now() + options.timeoutMs;
    for (;;) {
      const status = await this.status();
      if (predicate(status) || (deadline !== undefined && performance.now() >= deadline)) return status;
      await wait(deadline === undefined ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - performance.now())));
    }
  }

  async tell(body: string): Promise<TellResult> {
    const recorded = await recordTellBody(this.paths, this.id, body);
    return await wakeTell(this.paths, recorded.tellId);
  }

  async interrupt(body: string): Promise<InterruptReceipt> {
    const request = await requestPause(this.paths, new Date().toISOString());
    if (request.kind === "not-born") {
      throw new AkumaNotBornError(this.id);
    }

    let putDown: "was-idle" | "self-aborted" = "was-idle";
    let leash = await HeldAkumaLeash.try(this.paths);
    if (leash === null) {
      leash = await takeLeashUntil(this.paths, performance.now() + CONTROL_RESPONSE_MS);
      putDown = "self-aborted";
    }
    if (leash === null) {
      const body = (await readHeart(this.paths)).latestBody;
      return { kind: "unavailable", evidence: body?.sequence === request.body.sequence && body.hung !== undefined
        ? "hung"
        : "unavailable" };
    }

    const settledBody = (await readHeart(this.paths)).latestBody;
    if (settledBody?.sequence !== request.body.sequence || settledBody.end === undefined) {
      try { await leash.clearPause(this.paths); } finally { leash.release(); }
      return { kind: "unavailable", evidence: "untidy" };
    }
    if (request.body.end !== undefined || settledBody.end !== "put-down") putDown = "was-idle";

    let recorded: Readonly<{ kind: "recorded"; tellId: string }>;
    try {
      const id = randomUUID();
      const admitted = await leash.recordInterruptTell(this.paths, {
        kind: "tell",
        id,
        body,
        recordedAt: new Date().toISOString(),
      });
      if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
      recorded = { kind: "recorded", tellId: admitted.tell.id };
    } finally {
      leash.release();
    }
    return { kind: "interrupted", putDown, tell: await wakeTell(this.paths, recorded.tellId) };
  }

  async fork(input: Readonly<{ at: string }>): Promise<ForkReceipt> {
    const source = await readSoul(this.paths);
    if (source === null) throw new AkumaNotBornError(this.id);
    if (source.id !== this.id) throw new Error("Akuma soul does not match its coordinate");
    const adapter = resolveProviderExecution(source.provider).adapter;
    if (adapter.fork === undefined) return { kind: "provider-cannot-fork", provider: source.provider.name };
    const point = await readForkPoint(this.paths, input.at);
    if (point === null) return { kind: "unknown-history", at: input.at };
    if (point.provider !== source.provider.name) throw new Error(`Akuma fork point ${input.at} has a mismatched provider`);

    let childSession: ResumeCoordinate;
    try {
      childSession = (await adapter.fork({ session: point.session, at: point.historyId, cwd: point.cwd })).session;
    } catch (error) {
      return { kind: "fork-failed", diagnostic: diagnostic(error) };
    }

    const admittedAt = new Date().toISOString();
    const birthSession: Omit<SessionFact, "sequence"> = {
      provider: point.provider,
      coordinate: childSession,
      cwd: point.cwd,
      options: point.options,
      admittedAt,
    };
    try {
      const child = await publishAkuma({
        worldPath: this.worldPath,
        archetype: source.archetype,
        awaitAsleep: true,
        launch: async (allocated) => await spawnAkumaBody({
          paths: allocated.paths,
          seed: {
            id: allocated.id,
            archetype: source.archetype,
            ...(source.description === undefined ? {} : { description: source.description }),
            provider: source.provider,
            options: source.options,
            ...(source.readonly === undefined ? {} : { readonly: source.readonly }),
            allowed: source.allowed,
            cwd: source.cwd,
            origin: { kind: "fork", parent: this.id, at: input.at },
          },
          birthSession,
        }),
      });
      return { kind: "forked", child: child.id };
    } catch (error) {
      return {
        kind: "upstream-forked",
        childSession,
        diagnostic: diagnostic(error),
      };
    }
  }

  async kill(): Promise<KillEvidence> {
    const at = new Date().toISOString();
    const request = await requestStop(this.paths, at);
    if (request.kind !== "requested") return request.kind;
    const target = request.body;
    const graceDeadline = performance.now() + CONTROL_RESPONSE_MS;
    const leash = await takeLeashUntil(this.paths, graceDeadline);
    if (await readKill(this.paths, target.sequence) !== null) {
      leash?.release();
      return "killed";
    }
    if (leash === null) {
      if (await readKill(this.paths, target.sequence) !== null) return "killed";
      const body = (await readHeart(this.paths)).latestBody;
      return body?.sequence === target.sequence && body.hung !== undefined ? "hung" : "unavailable";
    }
    try {
      const settledBody = (await readHeart(this.paths)).latestBody;
      if (settledBody?.sequence !== target.sequence) return await readKill(this.paths, target.sequence) === null ? "unavailable" : "killed";
      if (settledBody.end !== "put-down") {
        await leash.clearStop(this.paths);
        return "untidy";
      }
      const settled = await leash.settleStop(this.paths, target.sequence);
      if (settled === null) return "unavailable";
      return "killed";
    } finally {
      leash.release();
    }
  }

  async lastAnswer(): Promise<LastAnswer> {
    const turn = await readLastAnsweredTurn(this.paths);
    return turn?.end?.outcome.kind === "answered"
      ? { kind: "answer", answer: turn.end.outcome.answer }
      : { kind: "no-answer" };
  }
}

/** Package-internal provenance retained only by the handle returned from call. */
export function akumaCallExecution(handle: AkumaHandle): AkumaCallExecution | undefined {
  return handle[CALL_EXECUTION];
}

export type LastAnswer =
  | Readonly<{ kind: "answer"; answer: string }>
  | Readonly<{ kind: "no-answer" }>;

type AkumaConfiguration = Readonly<{ home?: string; settings?: Settings }>;

export class Akuma {
  private constructor(private readonly path: WorldRoot, private readonly configuration: AkumaConfiguration) {}

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

  async call(input: AkumaCallInput): Promise<AkumaHandle> {
    return await this[CALL_WITH_CONTEXT](input, { initiatorCwd: process.cwd() });
  }

  async [CALL_WITH_CONTEXT](input: AkumaCallInput, context: AkumaCallContext): Promise<AkumaHandle> {
    const readonly = callReadonly(input.readonly);
    const name = archetypeName(input.archetype);
    const home = this.configuration.home === undefined ? {} : { home: this.configuration.home };
    const settings = this.configuration.settings ?? await readSettings({ root: this.path, ...home });
    const archetype = await loadArchetype({
      name,
      ...home,
      settings,
      ...readonly,
    });
    const allowed = input.allowed === undefined
      ? archetype.allowed
      : decodeAllowedActions(input.allowed, "Akuma call allowed");
    const requests = injectedBodyRequests();
    const requestRecipe = Object.freeze({
      ...(archetype.description === undefined ? {} : { description: archetype.description }),
      provider: archetype.provider,
      options: archetype.options,
      ...(archetype.readonly === undefined ? {} : { readonly: archetype.readonly }),
      allowed,
    });
    if (requests !== null) {
      const cwd = input.cwd === undefined
        ? undefined
        : context?.cwdCanonical === true ? input.cwd : await canonicalBirthCwd(input.cwd);
      const child = await requestBodyCall({
        directory: requests,
        id: randomUUID(),
        world: this.path,
        archetype: name,
        body: input.body,
        ...(cwd === undefined ? {} : { cwd }),
        recipe: requestRecipe,
      });
      const bornCwd = await readAkumaBirthCwd(this.path, child);
      return new AkumaHandle(child, this.path, {
        cwd: bornCwd,
        source: cwd === undefined ? "caller" : "input",
      });
    }
    const initiatorCwd = context.initiatorCwd;
    const selectedCwd = input.cwd ?? initiatorCwd ?? this.path;
    const cwd = input.cwd !== undefined && context?.cwdCanonical === true
      ? input.cwd
      : await canonicalBirthCwd(selectedCwd);
    const recipe = requestRecipe;
    const published = await publishAkuma({
      worldPath: this.path,
      archetype: archetype.name,
      launch: async (allocated) => await spawnAkumaBody({
        paths: allocated.paths,
        seed: {
          id: allocated.id,
          archetype: allocated.archetype,
          ...recipe,
          cwd,
          origin: { kind: "direct" },
        },
        initialBody: input.body,
      }),
    });
    return new AkumaHandle(published.id, this.path, {
      cwd,
      source: input.cwd !== undefined ? "input" : initiatorCwd === undefined ? "world" : "process",
    });
  }

  async list(input: AkumaListInput = {}): Promise<AkumaList> {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new TypeError("Akuma list input must be an object");
    }
    const unknown = Object.keys(input).find((key) => key !== "archetype");
    if (unknown !== undefined) throw new TypeError(`Akuma list input has unknown field: ${unknown}`);
    const selected = input.archetype === undefined ? undefined : archetypeName(input.archetype);
    const runRoot = akumaRunRoot(this.path);
    let names: string[];
    try {
      names = (await readdir(runRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], searched: [runRoot] };
      throw error;
    }
    const rows: AkumaList["rows"][number][] = [];
    for (const name of names) {
      let physical: ReturnType<typeof akuIdFromDirectoryName>;
      try {
        physical = akuIdFromDirectoryName(name);
      } catch {
        continue;
      }
      if (selected !== undefined && physical.archetype !== selected) continue;
      const paths = akumaPaths({ runRoot, archetype: physical.archetype, suffix: physical.suffix });
      try {
        rows.push(await fleetListRow(paths, physical.id));
      } catch {}
    }
    return {
      rows,
      searched: [runRoot],
    };
  }
}

/** Package-internal call path for a composition owner that already canonicalized cwd. */
export async function callAkumaWithContext(
  akuma: Akuma,
  input: AkumaCallInput,
  context: AkumaCallContext,
): Promise<AkumaHandle> {
  return await akuma[CALL_WITH_CONTEXT](input, context);
}
