import { z } from "zod";
import { akumaStatusSchema } from "./akuma.js";
import { activityRowSchema, activitySnapshotSchema } from "./projection.js";
import { tellResultSchema, pendingTellReceipt } from "./call-initial-tell.js";
import { akumaIdSchema } from "./identity.js";
import type { WorldRoot } from "../world.js";
import { AkumaNotBornError, AkumaProviderError, withTellFailureReceipt } from "./akuma-errors.js";
import type { LiveStatusObservation, OutcomeObserver } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import type { AkumaStatus } from "./akuma.js";
import { tellWakeRuntime, type TellResult } from "./body.js";
import type { BodyLauncher } from "./body-launch.js";
import {
  tellAdmissionEvidence,
  completeTell,
  type AkumaAskObservation,
  type AkumaAskResult,
  type AkumaKillResult,
  type AkumaTellResult,
} from "./selection-observation.js";

export const liveStatusObservationSchema = z
  .strictObject({
    status: akumaStatusSchema.unwrap().omit({ work: true }).extend({ timeline: activitySnapshotSchema }).readonly(),
    ordinarySelected: z.number(),
    rows: z.array(activityRowSchema).readonly(),
  })
  .readonly();
export const askProgressSchema = z.union([
  z.strictObject({ kind: z.literal("admitted"), tell: tellResultSchema, id: akumaIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("live"), observation: liveStatusObservationSchema }).readonly(),
]);
export type AskProgress = z.output<typeof askProgressSchema>;

export type AskObserver = Readonly<{
  admitted?: (tell: TellResult, id: AkumaStatus["id"]) => void | Promise<void>;
  observe?: (observation: LiveStatusObservation) => void | Promise<void>;
}>;

type TellExecutionInput = Readonly<{
  spawn: BodyLauncher;
  path: WorldRoot;
  id: AkumaStatus["id"];
  body: string;
  tellId?: string;
  recordedAt?: string;
  initiator?: string;
  signal?: AbortSignal;
  interrupt?: boolean;
  wait?: boolean;
  timeoutMs?: number;
  onObserve?: AskObserver;
  outcomeObserved?: OutcomeObserver;
}>;

type AskExecutionInput = TellExecutionInput & Readonly<{ timeoutMs?: number; schemaJson?: string }>;

export async function executeTellAkuma(input: TellExecutionInput): Promise<AkumaTellResult> {
  if (input.wait === true) {
    const { akumaId, tellId, wake, interrupt, ...observation } = await executeAskAkuma(input);
    return completeTell(
      { akumaId, tellId, ...(wake === undefined ? {} : { wake }), ...(interrupt === undefined ? {} : { interrupt }) },
      observation.kind === "invalid-output" ? { kind: "failed", diagnostic: observation.diagnostic } : observation,
    );
  }
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  const admission =
    input.interrupt === true
      ? await owner.admitInterrupt(input.body, input)
      : await owner.admitTell(input.body, input.tellId, input.recordedAt, tellWakeRuntime(input.spawn), input);
  if (admission.kind === "not-born") throw new AkumaNotBornError(input.id);
  if (admission.kind === "unavailable")
    throw new AkumaProviderError(`Tell interrupt unavailable: ${admission.evidence}`);
  let tell: TellResult = {
    ...pendingTellReceipt(admission.tell),
    ...("barrier" in admission && admission.barrier !== undefined
      ? { interruption: { kind: "pending", bodySequence: admission.barrier.bodySequence } }
      : {}),
  };
  try {
    tell = await ("wake" in admission
      ? admission.wake
      : owner.completeInterruptAdmission(admission, tellWakeRuntime(input.spawn), input.signal));
    input.signal?.throwIfAborted();
    return completeTell(tellAdmissionEvidence(input.id, tell));
  } catch (error) {
    throw withTellFailureReceipt(error, completeTell(tellAdmissionEvidence(input.id, tell)), input.signal);
  }
}

function askObservation(
  observed: Awaited<ReturnType<AkumaOwner["tellOutcome"]>>,
): AkumaAskObservation & { answer?: string } {
  if (observed.outcome === null) return observed.reason === "deadline" ? { kind: "deadline" } : { kind: "unanswered" };
  if (observed.outcome.kind === "canceled") return { kind: "unanswered" };
  if (observed.outcome.kind === "answered")
    return { kind: "answered", answer: observed.outcome.answerJson ?? observed.outcome.answer };
  if (observed.outcome.kind === "failed") return { kind: "failed", diagnostic: observed.outcome.diagnostic };
  return {
    kind: "invalid-output",
    diagnostic: observed.outcome.diagnostic,
    answer: observed.outcome.answer,
  };
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
    outcomeObserved?: OutcomeObserver;
  }>,
): Promise<AkumaAskResult & { answer?: string }> {
  const owner = new AkumaOwner(input.id, input.path, input.outcomeObserved);
  const tell = input.receipt ?? (await owner.admittedReceipt(input.tellId));
  await input.onObserve?.admitted?.(tell, input.id);
  let settled: TellResult | undefined;
  let wakeError: { error: unknown } | undefined;
  let wakeState: "launching" | "settled" | "failed" = input.wake === undefined ? "settled" : "launching";
  void input.wake?.then(
    (receipt) => {
      settled = receipt;
      wakeState = receipt.wake.kind === "failed" ? "failed" : "settled";
    },
    (error: unknown) => {
      wakeError = { error };
      wakeState = "failed";
    },
  );
  const admittedAt = Date.parse(tell.row.at);
  const observedAt = performance.timeOrigin + performance.now();
  const elapsed =
    input.startedAt === undefined
      ? Number.isFinite(admittedAt)
        ? Math.max(0, observedAt - admittedAt)
        : 0
      : Math.max(0, performance.now() - input.startedAt);
  let observed;
  try {
    observed = await owner.tellOutcome(input.tellId, {
      wake: () => {
        if (wakeError !== undefined) throw wakeError.error;
        return wakeState;
      },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, input.timeoutMs - elapsed) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onObserve?.observe === undefined ? {} : { observe: input.onObserve.observe }),
    });
  } catch (error) {
    throw withTellFailureReceipt(error, completeTell(tellAdmissionEvidence(input.id, settled ?? tell)), input.signal);
  }
  const receipt = tellAdmissionEvidence(input.id, settled ?? tell);
  const observation = askObservation(observed);
  const { wake, ...subject } = receipt;
  return observation.kind === "unanswered" || observation.kind === "deadline"
    ? { ...subject, ...(wake === undefined ? {} : { wake }), ...observation }
    : { ...subject, ...(wake?.kind === "failed" ? { wake } : {}), ...observation };
}

export async function executeAskAkuma(input: AskExecutionInput): Promise<AkumaAskResult & { answer?: string }> {
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  const admission =
    input.interrupt === true
      ? await owner.admitInterrupt(input.body, input)
      : await owner.admitTell(input.body, input.tellId, input.recordedAt, tellWakeRuntime(input.spawn), input);
  if (admission.kind === "not-born") throw new AkumaNotBornError(input.id);
  if (admission.kind === "unavailable")
    throw new AkumaProviderError(`Tell interrupt unavailable: ${admission.evidence}`);
  const observing = new AbortController();
  const signal = input.signal === undefined ? observing.signal : AbortSignal.any([input.signal, observing.signal]);
  const wake =
    "wake" in admission
      ? admission.wake
      : owner.completeInterruptAdmission(admission, tellWakeRuntime(input.spawn), signal);
  const receipt: TellResult = {
    ...pendingTellReceipt(admission.tell),
    ...("barrier" in admission && admission.barrier !== undefined
      ? { interruption: { kind: "pending", bodySequence: admission.barrier.bodySequence } }
      : {}),
  };
  try {
    return await observeAdmittedAskAkuma({
      ...input,
      tellId: admission.tell.id,
      receipt,
      wake,
      signal,
      startedAt: performance.now(),
    });
  } finally {
    if (!("wake" in admission)) {
      observing.abort(new Error("interrupt observation ended"));
      await wake.catch(() => undefined);
    }
  }
}

type KillExecutionInput = Readonly<{
  spawn: BodyLauncher;
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  signal?: AbortSignal;
}>;

export async function executeKillAkuma(input: KillExecutionInput): Promise<AkumaKillResult> {
  input.signal?.throwIfAborted();
  const owners = input.ids.map((id) => new AkumaOwner(id, input.path));
  const evidence = await Promise.all(
    owners.map(
      async (owner) => await owner.kill(input.spawn, input.signal === undefined ? {} : { signal: input.signal }),
    ),
  );
  input.signal?.throwIfAborted();
  return {
    results: input.ids.map((id, index) => ({ id, outcome: evidence[index]! })),
  };
}

/* ---------------------------------------------------------------------------
 * Native roster, akumaName listing and the one prepared call recipe
 * ------------------------------------------------------------------------ */
