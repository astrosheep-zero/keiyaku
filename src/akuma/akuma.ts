import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { boundedListLimit, projectBoundedList, type BoundedList } from "../bounded-list.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { Settings } from "../settings.js";
import { settings as readSettings } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { allowedActionsSchema, decodeAllowedActions, unionAllowedActions, type AllowedAction } from "./allowed.js";
import { AkumaArchetypeError, listArchetypes as readArchetypes, loadPreparedArchetype } from "./archetype.js";
import { AkumaNotBornError, AkumaProviderError } from "./akuma-errors.js";
import {
  bornLiveStatus,
  bornStatus,
  defaultWaitComplete,
  readAkumaBirthCwd,
  readLiveStatus,
  readWaitComplete,
  rosterListRow,
  waitForObservation,
  type LiveStatusObservation,
  type WaitReason,
} from "./akuma-observe.js";
import { canonicalBirthCwd } from "./call-input.js";
import { admitCallInitialTell, type CallInitialTell, type CallInitialTellAdmission } from "./call-initial-tell.js";
import { requestForwardedAkumaCall } from "./call-request.js";
import {
  handoffPendingTells,
  spawnAkumaBody,
  wakeRecordedTell,
  type BodyLaunch,
  type TellResult,
  type TellWakeRuntime,
} from "./body.js";
import { acquireLeash } from "./control.js";
import { executionChannel, type ExecutionContext } from "./requests.js";
import {
  HeldAkumaLeash,
  activitySlice,
  projectTell,
  readForkPoint,
  readHeart,
  readKill,
  readLastAnsweredTurn,
  readSoul,
  readTell,
  readTurn,
  recordTell,
  requestPause,
  requestStop,
  type AkumaLife,
  type KillEvidence,
  type ResumeCoordinate,
  type SessionFact,
  type TellFact,
  type TurnOutcome,
} from "./heart/index.js";
import { activitySnapshotSchema, projectTurns, selectExactHistory, selectHistory } from "./projection.js";
import type { ActivityHistory, ActivityRow, ExactHistory } from "./projection.js";
import { executePreparedCall, PreparedCallAdmissionError, publishAkuma } from "./publication.js";
import { resolveProviderExecution } from "./providers/index.js";
import {
  akuIdFromDirectoryName,
  akumaIdSchema,
  akumaPaths,
  akumaRunRoot,
  archetypeName,
  parsePublicHistoryId,
  pathsForAkuId,
  type AkuId,
  type AkumaPaths,
  type AllocatedAkuma,
} from "./identity.js";
import type { Schema } from "./schema.js";
import type { DispatchAssociation } from "./dispatch-association.js";
import type {
  AkumaAskObservation,
  AkumaAskResult,
  AkumaKillResult,
  AkumaTellResult,
  AkumaUnobserved,
} from "./selection-observation.js";

export type {
  AkumaAskObservation,
  AkumaAskResult,
  AkumaKillResult,
  AkumaTellResult,
  AkumaUnobserved,
} from "./selection-observation.js";

export type { KillEvidence };
export { akumaIdSchema };

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

export type AkumaCallExecution = Readonly<{
  cwd: string;
  source: "input" | "caller" | "process" | "world";
}>;

export type AkumaCallInput = Readonly<{
  archetype: string;
  body?: string;
  cwd?: string;
  allowed?: readonly AllowedAction[];
  schema?: Schema<unknown>;
  initiator?: string;
  signal?: AbortSignal;
}>;
export type AkumaCallContext = Readonly<{
  initiatorCwd?: string;
  cwdCanonical?: true;
}>;

export type AkumaConfiguration = Readonly<{ home?: string; settings?: Settings; execution?: ExecutionContext }>;

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

export type LastAnswer = Readonly<{ kind: "answer"; answer: string }> | Readonly<{ kind: "no-answer" }>;

export type TellAdmission =
  | Readonly<{ kind: "not-born" }>
  | Readonly<{ kind: "admitted"; tell: TellFact; wake: Promise<TellResult> }>;
export type InitialTellAdmission = CallInitialTellAdmission;

export type InterruptAdmission =
  | Readonly<{ kind: "unavailable"; evidence: "hung" | "untidy" | "unavailable" }>
  | Readonly<{
      kind: "admitted";
      tell: TellFact;
      putDown: "was-idle" | "self-aborted";
      wake: Promise<TellResult>;
    }>;

export type InitialCallTell = CallInitialTell;

/** One admitted call: the leading child identity plus the exact live initial Tell evidence when supplied. */
export type AdmittedAkumaCall = Readonly<{
  id: AllocatedAkuma["id"];
  cwd: string;
  execution: AkumaCallExecution;
  /** True when the serving process was reached through the one direct-parent request channel. */
  requested: boolean;
  tell?: TellResult;
  /** The native local failure, or the request transport's diagnostic text, after a confirmed birth. */
  failure?: unknown;
}>;

export { AkumaNotBornError } from "./akuma-errors.js";
export { defaultWaitComplete } from "./akuma-observe.js";
export { withoutReportedChanges } from "./projection.js";
export type * from "./projection.js";
export type { TellResult, TellWake } from "./body.js";

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function takeLeashUntilSignal(
  paths: AkumaPaths,
  bodySequence: number,
  signal?: AbortSignal,
  unbounded = false,
): Promise<HeldAkumaLeash | Readonly<{ kind: "unavailable"; evidence: "hung" | "untidy" | "unavailable" }>> {
  const leash = await acquireLeash(paths, {
    bodySequence,
    ...(signal === undefined && unbounded ? { deadline: Number.POSITIVE_INFINITY } : {}),
    ...(signal === undefined ? {} : { signal }),
  });
  if (leash !== null) return leash;
  const latestBody = (await readHeart(paths)).latestBody;
  if (latestBody?.sequence === bodySequence && latestBody.hung !== undefined)
    return { kind: "unavailable", evidence: "hung" };
  if (latestBody?.sequence === bodySequence && latestBody.end !== undefined)
    return { kind: "unavailable", evidence: "untidy" };
  return { kind: "unavailable", evidence: "unavailable" };
}

export async function settleAkumaKill(
  paths: AkumaPaths,
  signal?: AbortSignal,
  retainLeash = false,
): Promise<Readonly<{ evidence: KillEvidence; leash?: HeldAkumaLeash }>> {
  const request = await requestStop(paths, new Date().toISOString(), signal);
  if (request.kind !== "requested") {
    // A witnessed Body was already settled: the kill witness Heart recorded is
    // the kill evidence, not a stop outcome.
    const evidence: KillEvidence = request.kind === "witnessed" ? "killed" : request.kind;
    if (!retainLeash) return { evidence };
    const leash = await acquireLeash(paths, signal === undefined ? {} : { signal });
    return leash === null ? { evidence: "unavailable" } : { evidence, leash };
  }
  const target = request.body;
  const waited = await takeLeashUntilSignal(paths, target.sequence, signal);
  if ("kind" in waited) {
    if ((await readKill(paths, target.sequence)) !== null) return { evidence: "killed" };
    return { evidence: waited.evidence };
  }
  const leash = waited;
  let retain = false;
  try {
    if ((await readKill(paths, target.sequence)) !== null) return { evidence: "killed" };
    const settledBody = (await readHeart(paths)).latestBody;
    if (settledBody?.sequence !== target.sequence) {
      return { evidence: (await readKill(paths, target.sequence)) === null ? "unavailable" : "killed" };
    }
    if (settledBody.end !== "put-down") {
      await leash.clearStop(paths);
      return { evidence: "untidy" };
    }
    const settled = await leash.settleStop(paths, target.sequence);
    if (settled === null) return { evidence: "unavailable" };
    retain = retainLeash;
    return retainLeash ? { evidence: "killed", leash } : { evidence: "killed" };
  } finally {
    if (!retain) leash.release();
  }
}

export async function killAkumaWithRecovery(
  paths: AkumaPaths,
  recover?: (paths: AkumaPaths) => Promise<void>,
  signal?: AbortSignal,
): Promise<KillEvidence> {
  try {
    return (await settleAkumaKill(paths, signal)).evidence;
  } finally {
    if (recover !== undefined) void recover(paths).catch(() => undefined);
  }
}

/**
 * The one lower native Akuma owner: standalone identity, plural selection and
 * the request service all consume these same single-target algorithms. It reads
 * only Heart, leash, provider and filesystem state; optional Alias, Dispatch,
 * Task and Contract associations are composed above this boundary.
 */
export class AkumaOwner {
  constructor(
    readonly id: AkuId,
    private readonly worldPath: WorldRoot,
  ) {}

  private get paths(): AkumaPaths {
    return pathsForAkuId(this.worldPath, this.id);
  }

  private async projectHistoryTurns() {
    const slice = await activitySlice(this.paths);
    return projectTurns(slice.rows, { lowestRetained: slice.lowestRetained, highest: slice.highest });
  }

  private async exactHistory(
    input: Readonly<{ id?: string; before?: number; since?: number; limit?: number }>,
  ): Promise<ExactHistory> {
    if (typeof input.id !== "string" || input.id.trim() === "")
      throw new TypeError("Akuma history id must be a nonblank string");
    if (input.before !== undefined || input.since !== undefined || input.limit !== undefined)
      throw new TypeError("Akuma history id cannot be combined with before, since, or limit");
    if (parsePublicHistoryId(input.id) === null)
      throw new TypeError("Akuma history id must match turn/<positive safe integer>");
    return selectExactHistory((await this.projectHistoryTurns()).rows, input.id);
  }

  async status(): Promise<AkumaStatus> {
    return (await bornStatus(this.paths, this.id, { aperture: "monitoring" })).status;
  }

  async history(
    input: Readonly<{ id?: string; before?: number; since?: number; limit?: number }> = {},
  ): Promise<ActivityHistory | ExactHistory> {
    if (input.id !== undefined) return this.exactHistory(input);
    if (input.before !== undefined && input.since !== undefined) {
      throw new TypeError("Akuma history before and since are mutually exclusive");
    }
    for (const [name, value] of [
      ["before", input.before],
      ["since", input.since],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
        throw new TypeError(`Akuma history ${name} must be a positive safe integer`);
      }
    }
    const limit = input.limit ?? 12;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 5_000) {
      throw new TypeError("Akuma history limit must be a positive safe integer no greater than 5000");
    }
    return selectHistory(await this.projectHistoryTurns(), {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit,
    });
  }

  async waitReceipt(
    predicate: (status: AkumaStatus) => boolean = defaultWaitComplete,
    options: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {},
  ): Promise<Readonly<{ reason: WaitReason; status: AkumaStatus }>> {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      throw new TypeError("Akuma wait timeoutMs must be a nonnegative finite millisecond duration");
    }
    const waited = await executeWaitAkuma({
      path: this.worldPath,
      ids: [this.id],
      completion: "all",
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(predicate === defaultWaitComplete ? {} : { predicate }),
    });
    return { reason: waited.reason, status: waited.observations[0]! };
  }

  async wait(
    predicate: (status: AkumaStatus) => boolean = defaultWaitComplete,
    options: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {},
  ): Promise<AkumaStatus> {
    return (await this.waitReceipt(predicate, options)).status;
  }

  async admitInitialTell(
    initialTell: CallInitialTell,
    options: Readonly<{ signal?: AbortSignal; runtime?: TellWakeRuntime }> = {},
  ): Promise<InitialTellAdmission> {
    return await admitCallInitialTell({
      world: this.worldPath,
      id: this.id,
      initialTell,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wake: (tell) => wakeRecordedTell(this.paths, tell.id, options.runtime, options.signal),
    });
  }

  async tell(
    body: string,
    tellId: string = randomUUID(),
    recordedAt = new Date().toISOString(),
    runtime?: TellWakeRuntime,
    options: Readonly<{ schemaJson?: string; initiator?: string; signal?: AbortSignal }> = {},
  ): Promise<TellResult> {
    const admitted = await this.admitTell(body, tellId, recordedAt, runtime, options);
    if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
    return await admitted.wake;
  }

  /**
   * Record one Tell and start its wake without waiting for delivery. A bounded
   * caller starts its own deadline at this admission boundary while the wake
   * continues in the background; the unbounded public Tell awaits `wake`.
   */
  async admitTell(
    body: string,
    tellId: string = randomUUID(),
    recordedAt = new Date().toISOString(),
    runtime?: TellWakeRuntime,
    options: Readonly<{ schemaJson?: string; initiator?: string; signal?: AbortSignal }> = {},
  ): Promise<TellAdmission> {
    const { schemaJson, initiator, signal } = options;
    const admitted = await recordTell(this.paths, {
      kind: "tell",
      id: tellId,
      body,
      recordedAt,
      ...(initiator === undefined ? {} : { initiator }),
      ...(schemaJson === undefined ? {} : { schemaJson }),
    });
    if (admitted.kind === "not-born") return admitted;
    return {
      kind: "admitted",
      tell: admitted.tell,
      wake: wakeRecordedTell(this.paths, admitted.tell.id, runtime, signal),
    };
  }

  /**
   * The admitted Tell's receipt as it stands now. A bounded caller that stops
   * waiting before the wake settles reports this honest instant rather than a
   * delivery that has not happened yet.
   */
  async admittedReceipt(tellId: string): Promise<TellResult> {
    const tell = await readTell(this.paths, tellId);
    if (tell === null) throw new AkumaProviderError(`recorded Tell ${tellId} is missing from Heart`);
    const latestBody = (await readHeart(this.paths)).latestBody;
    return {
      admission: { tellId, fact: "recorded" },
      row: projectTell(tell),
      wake:
        tell.state === "told" || tell.binding !== undefined
          ? { kind: "told" }
          : latestBody !== null && latestBody.end === undefined && latestBody.hung === undefined
            ? { kind: "pursuing", bodySequence: latestBody.sequence }
            : { kind: "held" },
    };
  }

  /** Observe the exact admitted Tell's bound Turn without substituting Akuma-wide idleness. */
  async tellOutcome(
    tellId: string,
    options: Readonly<{
      timeoutMs?: number;
      signal?: AbortSignal;
      observe?: (observation: LiveStatusObservation) => void | Promise<void>;
    }> = {},
  ): Promise<Readonly<{ reason: WaitReason; outcome: TurnOutcome | null; completedAt: string | null }>> {
    const waited = await waitForObservation({
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      observe: async () => {
        const tell = await readTell(this.paths, tellId);
        if (tell === null) throw new AkumaProviderError(`recorded Tell ${tellId} is missing from Heart`);
        const outcome = await this.boundTellOutcome(tell);
        if (options.observe !== undefined) {
          await options.observe(
            await bornLiveStatus(this.paths, this.id, { aperture: "monitoring", admittedTellId: tellId }),
          );
        }
        return { ...outcome, terminalWithoutTurn: tell.state === "told" && tell.binding === undefined };
      },
      complete: (observed) => observed.outcome !== null || observed.terminalWithoutTurn,
    });
    return {
      reason: waited.reason,
      outcome: waited.value.outcome,
      completedAt: waited.value.completedAt,
    };
  }

  private async boundTellOutcome(
    tell: TellFact,
  ): Promise<Readonly<{ outcome: TurnOutcome | null; completedAt: string | null }>> {
    if (tell.binding === undefined) return { outcome: null, completedAt: null };
    const end = (await readTurn(this.paths, tell.binding.turnSequence))?.end;
    return { outcome: end?.outcome ?? null, completedAt: end?.completedAt ?? null };
  }

  async interrupt(
    body: string,
    options: Readonly<{
      tellId?: string;
      schemaJson?: string;
      initiator?: string;
      signal?: AbortSignal;
      runtime?: TellWakeRuntime;
    }> = {},
  ): Promise<InterruptReceipt> {
    const admitted = await this.admitInterrupt(body, options);
    if (admitted.kind === "unavailable") return admitted;
    return { kind: "interrupted", putDown: admitted.putDown, tell: await admitted.wake };
  }

  /**
   * Settle the predecessor and record the interrupt Tell, returning at the
   * admission boundary so a bounded caller owns the wake wait.
   */
  async admitInterrupt(
    body: string,
    options: Readonly<{
      tellId?: string;
      schemaJson?: string;
      initiator?: string;
      signal?: AbortSignal;
      runtime?: TellWakeRuntime;
    }> = {},
  ): Promise<InterruptAdmission> {
    const request = await requestPause(this.paths, new Date().toISOString(), options.signal);
    if (request.kind === "not-born") {
      throw new AkumaNotBornError(this.id);
    }

    let putDown: "was-idle" | "self-aborted" = "was-idle";
    let leash = await HeldAkumaLeash.try(this.paths);
    if (leash === null) {
      const waited = await takeLeashUntilSignal(this.paths, request.body.sequence, options.signal, true);
      if ("kind" in waited) return waited;
      leash = waited;
      putDown = "self-aborted";
    }
    let recorded: TellFact;
    try {
      options.signal?.throwIfAborted();

      const settledBody = (await readHeart(this.paths)).latestBody;
      if (settledBody?.sequence === request.body.sequence && settledBody.hung !== undefined) {
        await leash.clearPause(this.paths);
        return { kind: "unavailable", evidence: "hung" };
      }
      if (settledBody?.sequence !== request.body.sequence || settledBody.end === undefined) {
        await leash.clearPause(this.paths);
        return { kind: "unavailable", evidence: "untidy" };
      }
      if (request.body.end !== undefined || settledBody.end !== "put-down") putDown = "was-idle";

      options.signal?.throwIfAborted();
      const id = randomUUID();
      const admitted = await leash.recordInterruptTell(this.paths, {
        kind: "tell",
        id: options.tellId ?? id,
        body,
        recordedAt: new Date().toISOString(),
        ...(options.initiator === undefined ? {} : { initiator: options.initiator }),
        ...(options.schemaJson === undefined ? {} : { schemaJson: options.schemaJson }),
      });
      if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
      recorded = admitted.tell;
    } finally {
      leash.release();
    }
    return {
      kind: "admitted",
      tell: recorded,
      putDown,
      wake: wakeRecordedTell(this.paths, recorded.id, options.runtime, options.signal),
    };
  }

  async fork(input: Readonly<{ at: string }>): Promise<ForkReceipt> {
    const source = await readSoul(this.paths);
    if (source === null) throw new AkumaNotBornError(this.id);
    if (source.id !== this.id) throw new Error("Akuma soul does not match its coordinate");
    const adapter = (await resolveProviderExecution(source.provider)).adapter;
    if (adapter.fork === undefined) return { kind: "provider-cannot-fork", provider: source.provider.name };
    const point = await readForkPoint(this.paths, input.at);
    if (point === null) return { kind: "unknown-history", at: input.at };
    if (point.provider !== source.provider.name)
      throw new Error(`Akuma fork point ${input.at} has a mismatched provider`);

    let childSession: ResumeCoordinate;
    try {
      const attempt = adapter.fork({ session: point.session, at: point.historyId, cwd: point.cwd });
      childSession = (await attempt.result).session;
      await attempt.closed;
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
        launch: async (allocated) => {
          return await spawnAkumaBody({
            paths: allocated.paths,
            seed: {
              id: allocated.id,
              archetype: source.archetype,
              ...(source.description === undefined ? {} : { description: source.description }),
              provider: source.provider,
              options: source.options,
              allowed: source.allowed,
              cwd: source.cwd,
              origin: { kind: "fork", parent: this.id, at: input.at },
            },
            birthSession,
          });
        },
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

  async kill(options: Readonly<{ signal?: AbortSignal }> = {}): Promise<KillEvidence> {
    return await killAkumaWithRecovery(this.paths, handoffPendingTells, options.signal);
  }

  async lastAnswer(): Promise<LastAnswer> {
    const turn = await readLastAnsweredTurn(this.paths);
    return turn?.end?.outcome.kind === "answered"
      ? { kind: "answer", answer: turn.end.outcome.answer }
      : { kind: "no-answer" };
  }
}

/* ---------------------------------------------------------------------------
 * One wait owner and its legitimate observation modes
 * ------------------------------------------------------------------------ */

/** The alias and Dispatch association an upper caller resolves for one observed Akuma. */
export type WaitIdentityFacts = Readonly<{
  /** The alias currently addressing this Akuma in its world, when one is bound to it. */
  alias?: AkumaAlias;
  /** This Akuma's Dispatch association, read from the observing repository. */
  contract: DispatchAssociation;
}>;

/** One observed Akuma as a live wait viewer sees it: its status plus its identity facts. */
export type WaitObservedAkuma = Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }> & WaitIdentityFacts;

/** One selected Akuma's frozen identity, resolved before the first observation round. */
export type WaitSelectedAkuma = Readonly<{ id: AkumaStatus["id"] }> & WaitIdentityFacts;

/** A live wait viewer: the frozen selected set, then every observation round. */
export type WaitObserver = Readonly<{
  selected?: (selected: readonly WaitSelectedAkuma[]) => void;
  observe?: (observed: readonly WaitObservedAkuma[]) => void;
}>;

export type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal custom completion judge over the full final observation where supplied. */
  predicate?: (status: AkumaStatus) => boolean;
  /** Resolves one Akuma's identity facts; consulted once per Akuma a viewer first sees. */
  identity?: (id: AkumaStatus["id"]) => Promise<WaitIdentityFacts>;
  /** The selected set in the caller's order; a viewer's head and scoreboard follow it. */
  selectionOrder?: readonly AkumaStatus["id"][];
  /** Reports the frozen selected set before the first round, so a viewer can fix its layout. */
  onSelected?: (selected: readonly WaitSelectedAkuma[]) => void;
  /** Reports every observation round to a live viewer. */
  observe?: (observed: readonly WaitObservedAkuma[]) => void;
}>;

/** One wait's association-free native evidence; upper composition attaches cross-product context. */
export type NativeWaitResult = Readonly<{
  mode: "any" | "all";
  reason: WaitReason;
  observations: readonly AkumaStatus[];
  unobserved: readonly AkumaUnobserved[];
}>;

type WaitRound = Readonly<{
  observations: readonly LiveStatusObservation[];
  unobserved: readonly AkumaUnobserved[];
}>;

const SHARED_ORDINARY_BUDGET = 30;

async function observeWaitRound(
  path: WorldRoot,
  ids: readonly AkumaStatus["id"][],
  signal?: AbortSignal,
): Promise<WaitRound> {
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    const observations = await Promise.all(
      ids.map(async (id) => await readLiveStatus(path, id, { aperture: "monitoring" })),
    );
    return { observations, unobserved: [] };
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const observations: LiveStatusObservation[] = [];
  const unobserved: AkumaUnobserved[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await readLiveStatus(path, id, { aperture: "monitoring", ordinaryBudget: remaining });
      observations.push(observed);
      remaining -= observed.ordinarySelected;
    } catch (error) {
      if (error instanceof AkumaNotBornError) throw error;
      unobserved.push({ id, diagnostic: diagnostic(error) });
    }
  }
  return { observations, unobserved };
}

function roundComplete(
  round: WaitRound,
  completion: "any" | "all",
  predicate?: (status: AkumaStatus) => boolean,
): boolean {
  const judge = predicate ?? defaultWaitComplete;
  const settled = round.observations.map((observation) => judge(observation.status));
  return (
    settled.length > 0 &&
    (completion === "any" ? settled.some(Boolean) : round.unobserved.length === 0 && settled.every(Boolean))
  );
}

/** Canonical ids in the caller's selection order, appending any id the caller never named. */
function selectionOrderedIds(
  ids: readonly AkumaStatus["id"][],
  order: readonly AkumaStatus["id"][],
): readonly AkumaStatus["id"][] {
  const present = new Set(ids);
  const seen = new Set<AkumaStatus["id"]>();
  const ordered: AkumaStatus["id"][] = [];
  for (const id of order) {
    if (present.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * The one lower set-observation owner for Akuma wait completion. It serves the
 * standalone one-ID association-free face and the plural any/all face with one
 * ordered round algorithm, one shared ordinary-detail budget, transient
 * unreadable peers, and an honest final deadline edge. The default completion
 * probe is used only without live row callbacks and never with a custom
 * predicate; a live viewer always observes rounds.
 */
export async function executeWaitAkuma(input: WaitExecutionInput): Promise<NativeWaitResult> {
  // Identity facts are read once per observed Akuma, not once per 100ms round.
  const facts = new Map<AkumaStatus["id"], WaitIdentityFacts>();
  if (input.onSelected !== undefined) {
    for (const id of input.ids) {
      input.signal?.throwIfAborted();
      const known = input.identity === undefined ? undefined : await input.identity(id);
      facts.set(id, known ?? { contract: { kind: "none" } });
    }
    const ordered =
      input.selectionOrder === undefined ? input.ids : selectionOrderedIds(input.ids, input.selectionOrder);
    input.onSelected(ordered.map((id) => ({ id, ...facts.get(id)! })));
  }
  const observeRound = async (round: WaitRound): Promise<void> => {
    if (input.observe === undefined) return;
    const observed: WaitObservedAkuma[] = [];
    for (const observation of round.observations) {
      input.signal?.throwIfAborted();
      const { status, rows } = observation;
      let known = facts.get(status.id);
      if (known === undefined && input.identity !== undefined) {
        known = await input.identity(status.id);
        facts.set(status.id, known);
      }
      if (known === undefined) {
        observed.push({ status, rows, contract: { kind: "none" } });
        continue;
      }
      observed.push({ status, rows, ...known });
    }
    input.observe(observed);
  };
  const live = input.observe !== undefined;
  const waited = await waitForObservation({
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.predicate === undefined && !live && input.ids.length === 1
      ? { probe: async () => await readWaitComplete(input.path, input.ids[0]!) }
      : {}),
    observe: async () => await observeWaitRound(input.path, input.ids, input.signal),
    complete: (round) => roundComplete(round, input.completion, input.predicate),
    onObserve: async (round) => await observeRound(round),
  });
  return {
    mode: input.completion,
    reason: waited.reason,
    observations: waited.value.observations.map((observation) => observation.status),
    unobserved: waited.value.unobserved,
  };
}

export type AskObserver = Readonly<{
  admitted?: (tell: TellResult, id: AkumaStatus["id"]) => void | Promise<void>;
  observe?: (observation: LiveStatusObservation) => void | Promise<void>;
}>;

export type TellExecutionInput = Readonly<{
  path: WorldRoot;
  id: AkumaStatus["id"];
  body: string;
  tellId?: string;
  recordedAt?: string;
  initiator?: string;
  signal?: AbortSignal;
  interrupt?: boolean;
  onObserve?: AskObserver;
}>;

export async function executeTellAkuma(input: TellExecutionInput): Promise<AkumaTellResult> {
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  let tell;
  if (input.interrupt === true) {
    const interrupted = await owner.interrupt(input.body, {
      ...(input.tellId === undefined ? {} : { tellId: input.tellId }),
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (interrupted.kind === "unavailable")
      throw new AkumaProviderError(`Tell interrupt unavailable: ${interrupted.evidence}`);
    tell = interrupted.tell;
  } else {
    tell = await owner.tell(input.body, input.tellId, input.recordedAt, undefined, {
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
  input.signal?.throwIfAborted();
  return { akuma: input.id, tell };
}

function askObservation(observed: Awaited<ReturnType<AkumaOwner["tellOutcome"]>>): AkumaAskObservation {
  if (observed.outcome === null)
    return observed.reason === "deadline" ? { reason: "deadline" } : { reason: "unanswered" };
  if (observed.outcome.kind === "answered")
    return { reason: "answered", answer: observed.outcome.answerJson ?? observed.outcome.answer };
  if (observed.outcome.kind === "failed") return { reason: "failed", diagnostic: observed.outcome.diagnostic };
  return {
    reason: "invalid-output",
    diagnostic: observed.outcome.diagnostic,
    answer: observed.outcome.answer,
  };
}

export function decodeAskObservation<T>(observation: AkumaAskObservation, schema: Schema<T>): AkumaAskObservation<T> {
  if (observation.reason !== "answered") return observation;
  let value = observation.answer;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch (error) {
      return {
        reason: "invalid-output",
        diagnostic: error instanceof Error ? error.message : "Answer is not valid JSON",
        answer: typeof observation.answer === "string" ? observation.answer : String(observation.answer),
      };
    }
  }
  try {
    return { reason: "answered", answer: schema.decode(value) };
  } catch (error) {
    return {
      reason: "invalid-output",
      diagnostic: error instanceof Error ? error.message : "Answer failed schema decode",
      answer: typeof observation.answer === "string" ? observation.answer : String(observation.answer),
    };
  }
}

export async function observeAdmittedAskAkuma(
  input: Readonly<{
    path: WorldRoot;
    id: AkumaStatus["id"];
    tellId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    startedAt?: number;
    wake?: Promise<TellResult>;
    /**
     * The exact receipt of the admission this observation is bound to. The
     * call-facing seam always supplies it so observation never substitutes a
     * later Heart read for that invocation's admission evidence. Ordinary
     * Tell-bound asks may omit it and keep reading the current admitted receipt.
     */
    receipt?: TellResult;
    onObserve?: AskObserver;
  }>,
): Promise<AkumaAskResult> {
  const owner = new AkumaOwner(input.id, input.path);
  const tell = input.receipt ?? (await owner.admittedReceipt(input.tellId));
  await input.onObserve?.admitted?.(tell, input.id);
  let settled: TellResult | undefined;
  void input.wake?.then(
    (receipt) => {
      settled = receipt;
    },
    () => undefined,
  );
  const admittedAt = Date.parse(tell.row.at);
  const observedAt = performance.timeOrigin + performance.now();
  const elapsed =
    input.startedAt === undefined
      ? Number.isFinite(admittedAt)
        ? Math.max(0, observedAt - admittedAt)
        : 0
      : Math.max(0, performance.now() - input.startedAt);
  const observed = await owner.tellOutcome(input.tellId, {
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, input.timeoutMs - elapsed) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onObserve?.observe === undefined ? {} : { observe: input.onObserve.observe }),
  });
  return {
    akuma: input.id,
    tell: settled ?? tell,
    observation: askObservation(observed),
    completedAt: observed.completedAt,
  };
}

export async function executeAskAkuma(
  input: TellExecutionInput & Readonly<{ timeoutMs?: number; schemaJson?: string }>,
): Promise<AkumaAskResult> {
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  const admission =
    input.interrupt === true
      ? await owner.admitInterrupt(input.body, {
          ...(input.tellId === undefined ? {} : { tellId: input.tellId }),
          ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
          ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : await owner.admitTell(input.body, input.tellId, input.recordedAt, undefined, {
          ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
          ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
  if (admission.kind === "unavailable")
    throw new AkumaProviderError(`Tell interrupt unavailable: ${admission.evidence}`);
  if (admission.kind === "not-born") throw new AkumaNotBornError(input.id);
  return await observeAdmittedAskAkuma({
    path: input.path,
    id: input.id,
    tellId: admission.tell.id,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    startedAt: performance.now(),
    wake: admission.wake,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onObserve === undefined ? {} : { onObserve: input.onObserve }),
  });
}

export type KillExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  signal?: AbortSignal;
}>;

export async function executeKillAkuma(input: KillExecutionInput): Promise<AkumaKillResult> {
  input.signal?.throwIfAborted();
  const owners = input.ids.map((id) => new AkumaOwner(id, input.path));
  const evidence = await Promise.all(
    owners.map(async (owner) => await owner.kill(input.signal === undefined ? {} : { signal: input.signal })),
  );
  input.signal?.throwIfAborted();
  return {
    results: input.ids.map((id, index) => ({ id, evidence: evidence[index]! })),
  };
}

/* ---------------------------------------------------------------------------
 * Native roster, archetype listing and the one prepared call recipe
 * ------------------------------------------------------------------------ */

type AkumaCallRecipe = Omit<NonNullable<BodyLaunch["seed"]>, "id" | "archetype" | "cwd" | "origin">;

export type AkumaCallLaunchInput = Omit<AkumaCallInput, "body" | "schema"> &
  Readonly<{ initialTell?: InitialCallTell; contractId?: string }>;

export const PAGE_POOL_SIZE = 16;

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

type AkumaListRowValue = AkumaListRow | UnbornAkumaListRow;
type KnownAkuma = Readonly<{
  id: ReturnType<typeof akuIdFromDirectoryName>["id"];
  paths: ReturnType<typeof akumaPaths>;
}>;

export async function listAkumaArchetypes(
  path: WorldRoot,
  input: Readonly<{ home?: string }> = {},
): Promise<readonly string[]> {
  return readArchetypes({ project: path, ...(input.home === undefined ? {} : { home: input.home }) });
}

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
          await new AkumaOwner(id, input.path).admitInitialTell(initialTell, {
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

/**
 * The one lower recipe preparer and admission edge used by plural creation and
 * standalone birth: load the caller Archetype/Settings, freeze allowed and cwd,
 * then invoke the P3 prepared-call executor under local or request custody.
 */
export async function admitAkumaCall(
  path: WorldRoot,
  configuration: AkumaConfiguration,
  input: AkumaCallLaunchInput,
  context: AkumaCallContext,
): Promise<AdmittedAkumaCall> {
  const name = archetypeName(input.archetype);
  const home = configuration.home === undefined ? {} : { home: configuration.home };
  const settings = configuration.settings ?? (await readSettings({ root: path, ...home }));
  const archetype = await loadPreparedArchetype({ name, project: path, ...home, settings });
  const allowed =
    input.allowed === undefined
      ? archetype.allowed
      : unionAllowedActions(archetype.allowed, decodeAllowedActions(input.allowed, "Akuma call allowed"));
  const execution = executionChannel(configuration.execution);
  const requestRecipe = Object.freeze({
    ...(archetype.description === undefined ? {} : { description: archetype.description }),
    provider: archetype.provider,
    options: archetype.options,
    allowed,
  });
  if (execution.kind === "body-request")
    return await admitBodyRequest({ call: input, context, path, name, recipe: requestRecipe, execution });
  return await admitDirect({ call: input, context, path, archetype, recipe: requestRecipe });
}

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
