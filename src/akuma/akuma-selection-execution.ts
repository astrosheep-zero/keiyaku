import { z } from "zod";
import { akumaStatusSchema } from "./akuma.js";
import { activityRowSchema } from "./projection.js";
import { tellResultSchema, pendingTellReceipt } from "./call-initial-tell.js";
import { akumaIdSchema } from "./identity.js";
import type { WorldRoot } from "../world.js";
import {
  AkumaKillError,
  AkumaNotBornError,
  AkumaProviderError,
  withTellFailureReceipt,
  type KillAdmission,
} from "./akuma-errors.js";
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
    status: akumaStatusSchema,
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

async function admitExecutionTell(input: AskExecutionInput) {
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  const admission = await owner.admitTell(input.body, input);
  if (admission.kind === "not-born") throw new AkumaNotBornError(input.id);
  if (admission.kind === "unavailable")
    throw new AkumaProviderError(`Tell interrupt unavailable: ${admission.evidence}`);
  const receipt = pendingTellReceipt(admission.tell, admission.barrier);
  return { owner, admission, receipt };
}

export async function executeTellAkuma(input: TellExecutionInput): Promise<AkumaTellResult> {
  if (input.wait === true) {
    const { akumaId, tellId, wake, interrupt, ...observation } = await executeObservedTellAkuma(input);
    return completeTell(
      { akumaId, tellId, ...(wake === undefined ? {} : { wake }), ...(interrupt === undefined ? {} : { interrupt }) },
      observation.kind === "invalid-output" ? { kind: "failed", diagnostic: observation.diagnostic } : observation,
    );
  }
  const { owner, admission, receipt } = await admitExecutionTell(input);
  let tell = receipt;
  try {
    tell = await owner.settleTell(admission, tellWakeRuntime(input.spawn), {
      ...input,
      onProgress: (receipt) => {
        tell = receipt;
      },
    });
    input.signal?.throwIfAborted();
    return completeTell(tellAdmissionEvidence(input.id, tell));
  } catch (error) {
    throw withTellFailureReceipt(
      error,
      completeTell(tellAdmissionEvidence(input.id, tell), undefined, true),
      input.signal,
    );
  }
}

type TextObservation =
  | Exclude<AkumaAskObservation, { kind: "answered" }>
  | Readonly<{ kind: "answered"; answer: string; completedAt?: string }>;
type TextAskResult =
  | Exclude<AkumaAskResult, { kind: "answered" }>
  | (Omit<Extract<AkumaAskResult, { kind: "answered" }>, "answer"> & Readonly<{ answer: string }>);

function tellObservation(observed: Awaited<ReturnType<AkumaOwner["tellOutcome"]>>): TextObservation {
  if (observed.outcome === null) return observed.reason === "deadline" ? { kind: "deadline" } : { kind: "unanswered" };
  if (observed.outcome.kind === "canceled") return { kind: "unanswered" };
  const completedAt = observed.completedAt === null ? {} : { completedAt: observed.completedAt };
  if (observed.outcome.kind === "answered")
    return { kind: "answered", answer: observed.outcome.answerJson ?? observed.outcome.answer, ...completedAt };
  if (observed.outcome.kind === "failed")
    return { kind: "failed", diagnostic: observed.outcome.diagnostic, ...completedAt };
  return {
    kind: "invalid-output",
    diagnostic: observed.outcome.diagnostic,
    answer: observed.outcome.answer,
    ...completedAt,
  };
}

function observedTellResult(id: AkumaStatus["id"], tell: TellResult, observation: TextObservation): TextAskResult {
  const { action: _action, wake: settlement, interrupt, ...base } = tellAdmissionEvidence(id, tell);
  const subject = { ...base, ...(interrupt === undefined || interrupt.kind === "completed" ? {} : { interrupt }) };
  const wake =
    settlement?.kind === "confirmation-stopped"
      ? { kind: "failed" as const, diagnostic: settlement.diagnostic }
      : settlement;
  return observation.kind === "unanswered" || observation.kind === "deadline"
    ? { ...subject, ...(wake === undefined ? {} : { wake }), ...observation }
    : { ...subject, ...(wake?.kind === "failed" ? { wake } : {}), ...observation };
}

export async function observeAdmittedTellAkuma(
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
    knownReceipt?: () => TellResult;
    onObserve?: AskObserver;
    outcomeObserved?: OutcomeObserver;
  }>,
): Promise<TextAskResult> {
  const owner = new AkumaOwner(input.id, input.path, input.outcomeObserved);
  const tell = input.receipt ?? (await owner.admittedReceipt(input.tellId));
  let settled: TellResult | undefined;
  let wakeError: { error: unknown } | undefined;
  let wakeState: "launching" | "settled" | "failed" = input.wake === undefined ? "settled" : "launching";
  void input.wake?.then(
    (receipt) => {
      settled = receipt;
      wakeState = receipt.wake.kind === "failed" || receipt.wake.kind === "confirmation-stopped" ? "failed" : "settled";
    },
    (error: unknown) => {
      wakeError = { error };
      wakeState = "failed";
    },
  );
  const known = () => settled ?? input.knownReceipt?.() ?? tell;
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
    await input.onObserve?.admitted?.(tell, input.id);
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
    throw withTellFailureReceipt(
      error,
      completeTell(tellAdmissionEvidence(input.id, known()), undefined, true),
      input.signal,
    );
  }
  return observedTellResult(input.id, known(), tellObservation(observed));
}

export async function executeAskAkuma(input: AskExecutionInput): Promise<AkumaAskResult> {
  const result = await executeObservedTellAkuma(input);
  return result.kind === "answered" && input.schemaJson !== undefined
    ? { ...result, answer: JSON.parse(result.answer) }
    : result;
}

async function executeObservedTellAkuma(input: AskExecutionInput): Promise<TextAskResult> {
  const { owner, admission, receipt } = await admitExecutionTell(input);
  const startedAt = performance.now();
  const observing = new AbortController();
  const signal = input.signal === undefined ? observing.signal : AbortSignal.any([input.signal, observing.signal]);
  let known = receipt;
  const wake = owner.settleTell(admission, tellWakeRuntime(input.spawn), {
    observeAnswer: true,
    signal,
    onProgress: (progress) => {
      known = progress;
    },
  });
  try {
    return await observeAdmittedTellAkuma({
      ...input,
      tellId: admission.tell.id,
      receipt,
      knownReceipt: () => known,
      wake,
      signal,
      startedAt,
    });
  } finally {
    if (admission.barrier !== undefined) {
      observing.abort(new Error("interrupt observation ended"));
      await wake.catch(() => undefined);
    }
  }
}

type KillExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  signal?: AbortSignal;
}>;

export async function executeKillAkuma(input: KillExecutionInput): Promise<AkumaKillResult> {
  input.signal?.throwIfAborted();
  const options = input.signal === undefined ? {} : { signal: input.signal };
  const members = await Promise.all(
    input.ids.map(async (id) => {
      try {
        return { kind: "settled" as const, value: { id, outcome: await new AkumaOwner(id, input.path).kill(options) } };
      } catch (reason) {
        return { kind: "failed" as const, reason };
      }
    }),
  );
  const failed = members.find((member) => member.kind === "failed");
  if (failed === undefined)
    return { results: members.flatMap((member) => (member.kind === "settled" ? [member.value] : [])) };
  const known = members.flatMap<KillAdmission>((member) =>
    member.kind === "settled" ? [member.value] : member.reason instanceof AkumaKillError ? member.reason.kill : [],
  );
  const reason = failed.reason instanceof AkumaKillError ? failed.reason.cause : failed.reason;
  if (known.length === 0) throw reason;
  throw new AkumaKillError(reason, known, input.signal);
}

/* ---------------------------------------------------------------------------
 * Native roster, akumaName listing and the one prepared call recipe
 * ------------------------------------------------------------------------ */
