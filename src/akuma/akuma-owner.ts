import { errorCategory, KeiyakuError } from "../errors.js";
import { bareOption, durationSchema, validateAkumaInput } from "./call-input.js";
import { decodeAkumaCaller, type AkumaCaller } from "./caller.js";
import { randomUUID } from "node:crypto";
import type { WorldRoot } from "../world.js";
import { AkumaKillError, AkumaNotBornError, AkumaProviderError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  bornStatus,
  executionProgress,
  observeOutcomeRows,
  observeStatusOutcome,
  type OutcomeObserver,
  waitForObservation,
  type LiveStatusObservation,
  type WaitReason,
} from "./akuma-observe.js";
import { executeWaitAkuma } from "./akuma-wait.js";
import { createAkumaStream, type AkumaStreamSnapshot } from "./akuma-stream.js";
import type { BodyLauncher } from "./body-launch.js";
import { evidencedTellWake, wakeRecordedTell, type TellResult, type TellWakeRuntime } from "./body.js";
import { pendingTellReceipt, type CallInitialTell, type CallInitialTellAdmission } from "./call-initial-tell.js";
import { acquireLeash, confirmAction, confirmationTimedOut } from "./control.js";
import {
  HeldAkumaLeash,
  activitySlice,
  readForkPoint,
  readInterruptCompletion,
  readStopEvidence,
  readLastAnsweredTurn,
  readSoul,
  readTellAction,
  recordReport,
  recordSurveillance,
  recordTell,
  requestStop,
  type InterruptCompletion,
  type InterruptTellAdmission,
  type KillEvidence,
  type ResumeCoordinate,
  type SessionFact,
  type TellFact,
  type TurnOutcome,
  type PauseFact,
} from "./heart/index.js";
import {
  akumaIdSchema,
  parseExactHistorySelector,
  pathsForAkumaId,
  type AkumaId,
  type AkumaPaths,
} from "./identity.js";
import { HeartUnbornError, type ReportAdmission } from "./heart/facts.js";
import type { ActivityHistory, ExactHistory } from "./projection.js";
import { projectFact, selectExactHistory, selectHistory } from "./projection.js";
import type { AkumaWaitItem } from "./selection-observation.js";
import { resolveProviderExecution } from "./providers/index.js";
import { publishAkuma } from "./publication.js";
import { z } from "zod";
import { publicSessionCoordinate, publicSessionCoordinateSchema, type PublicSessionCoordinate } from "./coordinate.js";

import { historyPageSchemas } from "../history.js";

export const historyInputSchemas = [
  z.strictObject({
    id: z
      .string()
      .regex(/^(?:(?:turn|report)\/)?[1-9][0-9]*$/u)
      .refine((id) => parseExactHistorySelector(id) !== null, {
        message:
          "id must be a positive safe decimal integer, turn/<positive safe integer> or report/<positive safe integer>",
      }),
  }),
  ...historyPageSchemas,
] as const;
const historyInputSchema = z.union(historyInputSchemas);

export const akumaSurveillanceResultSchema = z
  .strictObject({ id: akumaIdSchema, kind: z.enum(["recorded", "unchanged"]) })
  .readonly();

export type AkumaSurveillanceResult = z.output<typeof akumaSurveillanceResultSchema>;

export type InterruptReceipt = TellResult | Extract<InterruptTellAdmission, { kind: "unavailable" }>;

export const forkFailureSchemas = {
  unsupported: z.strictObject({ kind: z.literal("provider-cannot-fork") }).readonly(),
  unknownHistory: z.strictObject({ kind: z.literal("unknown-history") }).readonly(),
  failed: z.strictObject({ kind: z.literal("fork-failed"), diagnostic: z.string() }).readonly(),
  upstream: z
    .strictObject({
      kind: z.literal("provider-forked-local-birth-failed"),
      session: publicSessionCoordinateSchema,
      diagnostic: z.string(),
    })
    .readonly(),
};

export type ForkReceipt =
  | Readonly<{ kind: "forked"; childAkumaId: AkumaId }>
  | Readonly<{ kind: "provider-cannot-fork" }>
  | Readonly<{ kind: "unknown-history" }>
  | Readonly<{ kind: "fork-failed"; diagnostic: string }>
  | Readonly<{ kind: "provider-forked-local-birth-failed"; session: PublicSessionCoordinate; diagnostic: string }>;

export type LastAnswer =
  | Readonly<{ kind: "answer"; answer: string; historyId: `turn/${number}` }>
  | Readonly<{ kind: "no-answer" }>;

type AdmittedTell = Readonly<{ tell: TellFact; barrier?: PauseFact }>;

async function awaitInterruptCompletion(
  paths: AkumaPaths,
  barrier: PauseFact,
  signal: AbortSignal,
): Promise<Extract<InterruptCompletion, { kind: "completed" | "unavailable" }>> {
  const leash = await acquireLeash(paths, { bodySequence: barrier.bodySequence, deadline: Infinity, signal });
  if (leash === null) return await readInterruptCompletion(paths, barrier, signal);
  try {
    const result = await leash.completeInterruptBarrier(paths, barrier, signal);
    if (result.kind === "completed" || result.kind === "unavailable") return result;
    return { kind: "unavailable", evidence: "untidy" };
  } finally {
    leash.release();
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type KillSettlement = Readonly<{ evidence: KillEvidence; leash?: HeldAkumaLeash }>;

export async function settleAkumaKill(
  paths: AkumaPaths,
  signal?: AbortSignal,
  retainLeash = false,
  onStop?: () => void,
): Promise<KillSettlement> {
  const request = await requestStop(paths, new Date().toISOString(), signal);
  if (request.kind !== "requested") {
    // A witnessed Body was already settled: the kill witness Heart recorded is
    // the kill evidence, not a stop outcome.
    const evidence: KillEvidence = request.kind === "witnessed" ? "killed" : request.kind;
    if (!retainLeash || evidence === "hung") return { evidence };
    const leash = await acquireLeash(paths, signal === undefined ? {} : { signal });
    return leash === null ? { evidence: "unavailable" } : { evidence, leash };
  }
  onStop?.();
  const bodySequence = request.body.sequence;
  const stopped = async (observation: AbortSignal): Promise<KillEvidence | undefined> => {
    const { body, outcome } = await readStopEvidence(paths, bodySequence, observation);
    return outcome ?? (body?.end === undefined ? undefined : "untidy");
  };
  return await confirmAction<KillSettlement>(
    signal,
    async (observation) => {
      const leash = await acquireLeash(paths, {
        bodySequence,
        signal: observation,
        ...(signal === undefined ? {} : { deadline: Infinity }),
      });
      if (leash === null) return { evidence: (await stopped(observation)) ?? "unavailable" };
      let retain = false;
      try {
        const { outcome, body } = await readStopEvidence(paths, bodySequence, observation);
        if (outcome !== undefined) return { evidence: outcome };
        if (body?.end !== "put-down") {
          await leash.clearStop(paths, observation);
          return { evidence: "untidy" };
        }
        if ((await leash.settleStop(paths, bodySequence, observation)) === null) return { evidence: "unavailable" };
        retain = retainLeash;
        return retain ? { evidence: "killed", leash } : { evidence: "killed" };
      } finally {
        if (!retain) leash.release();
      }
    },
    async (observation) => {
      try {
        const evidence = await stopped(observation);
        if (evidence !== undefined) return { evidence };
      } catch (error) {
        signal?.throwIfAborted();
        if (!confirmationTimedOut(error)) throw error;
      }
      if (retainLeash) return { evidence: "unavailable" };
      throw new Error("Stop not confirmed before the action deadline; admitted stop can still advance");
    },
  );
}

/**
 * The one lower native Akuma owner: standalone identity, plural selection and
 * the request service all consume these same single-target algorithms. It reads
 * only Heart, leash, provider and filesystem state; optional Alias, Dispatch,
 * Debt and Contract associations are composed above this boundary.
 */
export class AkumaOwner {
  constructor(
    readonly id: AkumaId,
    private readonly worldPath: WorldRoot,
    private readonly outcomeObserved?: OutcomeObserver,
  ) {}

  private get paths(): AkumaPaths {
    return pathsForAkumaId(this.worldPath, this.id);
  }

  private async historyTimeline() {
    const slice = await activitySlice(this.paths);
    return { ...slice, rows: slice.rows.map(projectFact) };
  }

  private async exactHistory(id: string): Promise<ExactHistory> {
    const selector = parseExactHistorySelector(id);
    if (selector === null)
      throw new KeiyakuError(
        "invalid-input",
        "Akuma history id must be a positive safe decimal integer, turn/<positive safe integer> or report/<positive safe integer>",
      );
    const timeline = await this.historyTimeline();
    if (selector.kind !== "activity")
      return selectExactHistory(timeline.rows, { kind: selector.kind, sequence: selector.sequence });
    const row = timeline.rows.find((row) => row.sequence === selector.sequence);
    return row === undefined || row.kind === "turn" || row.kind === "outcome"
      ? { kind: "unknown-history", id }
      : { kind: "exact-activity", row };
  }

  async surveil(owner: string, off: boolean, signal?: AbortSignal): Promise<AkumaSurveillanceResult> {
    try {
      return { id: this.id, kind: await recordSurveillance(this.paths, this.id, owner, off, signal) };
    } catch (error) {
      if (error instanceof HeartUnbornError) throw new AkumaNotBornError(this.id);
      throw error;
    }
  }

  async report(input: Readonly<{ text: string; at: string }>, signal?: AbortSignal): Promise<ReportAdmission> {
    return await recordReport(this.paths, input, signal);
  }

  async status(): Promise<LiveStatusObservation["status"]> {
    const status = await bornStatus(this.paths, this.id);
    await observeStatusOutcome(status, this.outcomeObserved);
    return status;
  }

  async history(
    input: Readonly<{ id?: string; before?: number; since?: number; limit?: number }> = {},
  ): Promise<ActivityHistory | ExactHistory> {
    validateAkumaInput(historyInputSchema, input);
    if (input.id !== undefined) {
      const exact = await this.exactHistory(input.id);
      if (exact.kind === "exact") await this.outcomeObserved?.(this.id, [`turn/${exact.outcome.turnSequence}`]);
      return exact;
    }
    const limit = input.limit ?? 12;
    const history = selectHistory(await this.historyTimeline(), {
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(input.since === undefined ? {} : { since: input.since }),
      limit,
    });
    await observeOutcomeRows(this.id, history.rows, this.outcomeObserved);
    return history;
  }

  /**
   * Continuously observe that same retained timeline. Each emission is the whole
   * latest bounded window through the existing history projection, and the
   * operation observes until its caller stops pulling or aborts.
   */
  stream(options: Readonly<{ signal?: AbortSignal }> = {}): AsyncIterable<AkumaStreamSnapshot> {
    return createAkumaStream(this.paths, this.id, options, this.outcomeObserved);
  }

  async waitReceipt(
    options: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {},
  ): Promise<Readonly<{ reason: WaitReason; status: Extract<AkumaWaitItem, { kind: "observed" }> }>> {
    validateAkumaInput(durationSchema.optional(), options.timeoutMs);
    const waited = await executeWaitAkuma({
      path: this.worldPath,
      ids: [this.id],
      completion: "all",
      ...options,
      ...(this.outcomeObserved === undefined ? {} : { outcomeObserved: this.outcomeObserved }),
    });
    const status = waited.results[0];
    if (status?.kind === "missing") throw new AkumaNotBornError(this.id);
    if (status?.kind !== "observed") {
      throw new AkumaProviderError(
        status?.kind === "unobserved" ? status.diagnostic : "Akuma wait returned no observation",
      );
    }
    return { reason: waited.reason, status };
  }

  async wait(options: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {}) {
    return (await this.waitReceipt(options)).status;
  }

  async admitInitialTell(
    initialTell: CallInitialTell,
    options: Readonly<{ signal?: AbortSignal; runtime: TellWakeRuntime; observeAnswer?: boolean }>,
  ): Promise<CallInitialTellAdmission> {
    const admitted = await this.admitTell(initialTell.body, { ...options, ...initialTell });
    if (admitted.kind === "not-born") return admitted;
    if (admitted.kind !== "recorded") throw new Error("Uninterrupting initial Tell refused control");
    return { kind: "admitted", tell: admitted.tell, wake: this.settleTell(admitted, options.runtime, options) };
  }

  async tell(
    body: string,
    tellId: string = randomUUID(),
    recordedAt = new Date().toISOString(),
    runtime: TellWakeRuntime,
    options: Readonly<{ schemaJson?: string; initiator?: string; signal?: AbortSignal }> = {},
  ): Promise<TellResult> {
    const admitted = await this.admitTell(body, { ...options, tellId, recordedAt });
    if (admitted.kind !== "recorded") throw new AkumaNotBornError(this.id);
    return await this.settleTell(admitted, runtime, options);
  }

  /** Admission is independent of the invocation's action or answer observation. */
  async admitTell(
    body: string,
    options: Readonly<{
      tellId?: string;
      recordedAt?: string;
      schemaJson?: string;
      initiator?: string;
      signal?: AbortSignal;
      interrupt?: boolean;
    }> = {},
  ): Promise<InterruptTellAdmission> {
    const { schemaJson, initiator, signal } = options;
    const tell = {
      kind: "tell" as const,
      id: options.tellId ?? randomUUID(),
      body,
      recordedAt: options.recordedAt ?? new Date().toISOString(),
      ...(initiator === undefined ? {} : { initiator }),
      ...(schemaJson === undefined ? {} : { schemaJson }),
    };
    const cancellation = signal === undefined ? {} : { signal };
    return options.interrupt === true
      ? await recordTell(this.paths, tell, { interrupt: true, ...cancellation })
      : await recordTell(this.paths, tell, cancellation);
  }

  /** Observe the exact admitted Tell's bound Turn without substituting Akuma-wide idleness. */
  async tellOutcome(
    tellId: string,
    options: Readonly<{
      timeoutMs?: number;
      signal?: AbortSignal;
      observe?: (observation: LiveStatusObservation) => void | Promise<void>;
      wake?: () => "launching" | "settled" | "failed";
    }> = {},
  ): Promise<Readonly<{ reason: WaitReason; outcome: TurnOutcome | null; completedAt: string | null }>> {
    const reader = createLiveStatusReader(this.paths, this.id);
    const { observe, signal } = options;
    try {
      const waited = await waitForObservation({
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(signal === undefined ? {} : { signal }),
        observe: async () => {
          const { tell, end, life, live } = await reader.tellOutcome(tellId, observe !== undefined, signal);
          const progress = executionProgress(life, true, options.wake?.());
          if (tell === null) throw new AkumaProviderError(`recorded Tell ${tellId} is missing from Heart`);
          if (end !== undefined) await this.outcomeObserved?.(this.id, [`turn/${end.turnSequence}`]);
          if (live !== undefined) await observe?.(await live());
          return {
            outcome: end?.outcome ?? null,
            completedAt: end?.completedAt ?? null,
            terminalWithoutTurn: (tell.state === "told" && tell.binding === undefined) || progress === "stopped",
          };
        },
        complete: (observed) => observed.outcome !== null || observed.terminalWithoutTurn,
      });
      return {
        reason: waited.reason,
        outcome: waited.value.outcome,
        completedAt: waited.value.completedAt,
      };
    } finally {
      reader.clear();
    }
  }

  async interrupt(
    body: string,
    options: Readonly<{
      tellId?: string;
      recordedAt?: string;
      schemaJson?: string;
      initiator?: string;
      signal?: AbortSignal;
      runtime: TellWakeRuntime;
    }>,
  ): Promise<InterruptReceipt> {
    const admitted = await this.admitTell(body, { ...options, interrupt: true });
    if (admitted.kind === "not-born") throw new AkumaNotBornError(this.id);
    if (admitted.kind === "unavailable") return admitted;
    return await this.settleTell(admitted, options.runtime, options);
  }

  async settleTell(
    { tell, barrier }: AdmittedTell,
    runtime: TellWakeRuntime,
    options: Readonly<{
      signal?: AbortSignal;
      observeAnswer?: boolean;
      onProgress?: (receipt: TellResult) => void;
    }> = {},
  ): Promise<TellResult> {
    const paths = this.paths;
    let receipt = pendingTellReceipt(tell, barrier);
    const interruption = (result: Extract<InterruptCompletion, { kind: "completed" | "unavailable" }>) => {
      receipt = { ...receipt, interruption: { ...result, bodySequence: barrier!.bodySequence } };
      if (result.kind === "unavailable") {
        receipt = {
          ...receipt,
          wake: {
            kind: "confirmation-stopped",
            reason: result.evidence,
            diagnostic: `Could not complete interrupt: ${result.evidence} custody`,
          },
        };
      }
      options.onProgress?.(receipt);
    };
    const settle = async (signal: AbortSignal): Promise<TellResult> => {
      if (barrier !== undefined) {
        const result = await awaitInterruptCompletion(paths, barrier, signal);
        interruption(result);
        if (result.kind === "unavailable") return receipt;
      }
      const wake = await wakeRecordedTell(paths, tell.id, runtime, signal, options.observeAnswer !== true);
      return { ...receipt, wake };
    };
    if (options.observeAnswer) return await settle(options.signal ?? new AbortController().signal);
    return await confirmAction(options.signal, settle, async (signal) => {
      let custody = "";
      try {
        if (barrier !== undefined && receipt.interruption?.kind === "pending") {
          const latest = await readInterruptCompletion(paths, barrier, signal);
          if (latest.kind === "completed" || latest.evidence === "hung") {
            interruption(latest);
            if (latest.kind === "unavailable") return receipt;
          }
        }
        const observed = await readTellAction(paths, tell.id, signal);
        const wake = evidencedTellWake(observed);
        if (wake !== null && receipt.interruption?.kind !== "pending") return { ...receipt, wake };
        if (observed.kind === "pending" && observed.control !== null) custody = ` (${observed.control} retained)`;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (!confirmationTimedOut(error)) throw error;
      }
      return {
        ...receipt,
        wake: {
          kind: "confirmation-stopped",
          reason: "deadline",
          diagnostic: `Tell submission not confirmed before the action deadline${custody}; admitted input can still advance`,
        },
      };
    });
  }

  async fork(
    input: Readonly<{ at: string; bare?: boolean; caller?: AkumaCaller; initiator?: string }>,
    spawn: BodyLauncher,
  ): Promise<ForkReceipt> {
    const bare = bareOption(input.bare);
    const caller = decodeAkumaCaller(input.caller);
    const source = await readSoul(this.paths);
    if (source === null) throw new AkumaNotBornError(this.id);
    if (source.id !== this.id) throw new Error("Akuma soul does not match its coordinate");
    const adapter = (await resolveProviderExecution(source.provider)).adapter;
    if (adapter.fork === undefined) return { kind: "provider-cannot-fork" };
    const point = await readForkPoint(this.paths, input.at);
    if (point === null) return { kind: "unknown-history" };
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
    let birth: Awaited<ReturnType<typeof publishAkuma>>;
    try {
      birth = await publishAkuma({
        worldPath: this.worldPath,
        akumaName: source.akumaName,
        launch: async (allocated) =>
          await spawn({
            paths: allocated.paths,
            seed: {
              id: allocated.id,
              akumaName: source.akumaName,
              ...(source.description === undefined ? {} : { description: source.description }),
              provider: source.provider,
              options: source.options,
              bare: source.bare === true || bare === true,
              cwd: source.cwd,
              origin: { kind: "fork", parent: this.id, at: input.at },
              ...(caller === undefined ? {} : { caller }),
            },
            birthSession,
            ...(input.initiator === undefined ? {} : { birthInitiator: input.initiator }),
          }),
      });
    } catch (error) {
      return {
        kind: "provider-forked-local-birth-failed",
        session: publicSessionCoordinate(childSession),
        diagnostic: diagnostic(error),
      };
    }
    if (birth.failureStage !== undefined)
      throw new KeiyakuError(
        errorCategory(birth.failure),
        `Forked child ${birth.child.id}: ${diagnostic(birth.failure)}`,
        { cause: birth.failure },
      );
    return { kind: "forked", childAkumaId: birth.child.id };
  }

  async kill(options: Readonly<{ signal?: AbortSignal }> = {}): Promise<KillEvidence> {
    let admitted = false;
    try {
      return (
        await settleAkumaKill(this.paths, options.signal, false, () => {
          admitted = true;
        })
      ).evidence;
    } catch (error) {
      if (!admitted) throw error;
      throw new AkumaKillError(error, [{ id: this.id, outcome: "stop-admitted" }], options.signal);
    }
  }

  async lastAnswer(): Promise<LastAnswer> {
    const turn = await readLastAnsweredTurn(this.paths);
    if (turn?.end?.outcome.kind !== "answered") return { kind: "no-answer" };
    await this.outcomeObserved?.(this.id, [`turn/${turn.sequence}`]);
    return { kind: "answer", answer: turn.end.outcome.answer, historyId: `turn/${turn.sequence}` };
  }
}

/* ---------------------------------------------------------------------------
 * One wait owner and its legitimate observation modes
 * ------------------------------------------------------------------------ */

/** The alias and Dispatch association an upper caller resolves for one observed Akuma. */
