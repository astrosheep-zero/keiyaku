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

type AskExecutionInput = TellExecutionInput & Readonly<{ schemaJson?: string }>;

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
    const { receipt, observation } = await executeObservedTellAkuma(input);
    const { subject, pending } = observedTellEvidence(input.id, receipt);
    return completeTell(
      observation.kind === "unanswered" || observation.kind === "deadline" ? { ...subject, ...pending } : subject,
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

function tellObservation({ outcome, reason, completedAt }: Awaited<ReturnType<AkumaOwner["tellOutcome"]>>) {
  if (outcome === null && reason === "deadline") return { kind: "deadline" } as const;
  if (outcome === null || outcome.kind === "canceled") return { kind: "unanswered" } as const;
  const time = completedAt === null ? {} : { completedAt };
  if (outcome.kind === "answered") return { kind: outcome.kind, answer: outcome.answerJson ?? outcome.answer, ...time };
  const { kind, diagnostic } = outcome;
  return kind === "failed" ? { kind, diagnostic, ...time } : { kind, diagnostic, answer: outcome.answer, ...time };
}

function observedTellEvidence(id: AkumaStatus["id"], tell: TellResult) {
  const { action: _action, wake, interrupt, ...base } = tellAdmissionEvidence(id, tell);
  const failed =
    wake?.kind === "confirmation-stopped" ? { kind: "failed" as const, diagnostic: wake.diagnostic } : wake;
  return {
    subject: {
      ...base,
      ...(interrupt === undefined || interrupt.kind === "completed" ? {} : { interrupt }),
      ...(failed?.kind === "failed" ? { wake: failed } : {}),
    },
    pending: wake?.kind === "pending" ? { wake } : {},
  };
}

export async function observeAdmittedTellAkuma(
  input: Readonly<{
    path: WorldRoot;
    id: AkumaStatus["id"];
    receipt: TellResult;
    timeoutMs?: number;
    signal?: AbortSignal;
    startedAt?: number;
    wake?: Promise<TellResult>;
    knownReceipt?: () => TellResult;
    onObserve?: AskObserver;
    outcomeObserved?: OutcomeObserver;
  }>,
) {
  const { receipt: tell } = input;
  const owner = new AkumaOwner(input.id, input.path, input.outcomeObserved);
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
  const admittedAt = input.startedAt ?? Date.parse(tell.row.at) - performance.timeOrigin;
  const elapsed = Number.isFinite(admittedAt) ? Math.max(0, performance.now() - admittedAt) : 0;
  try {
    await input.onObserve?.admitted?.(tell, input.id);
    const observed = await owner.tellOutcome(tell.admission.tellId, {
      wake: () => {
        if (wakeError !== undefined) throw wakeError.error;
        return wakeState;
      },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, input.timeoutMs - elapsed) }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onObserve?.observe === undefined ? {} : { observe: input.onObserve.observe }),
    });
    return { receipt: known(), observation: tellObservation(observed) };
  } catch (error) {
    throw withTellFailureReceipt(
      error,
      completeTell(tellAdmissionEvidence(input.id, known()), undefined, true),
      input.signal,
    );
  }
}

export async function executeAskAkuma(input: AskExecutionInput): Promise<AkumaAskResult> {
  const { receipt, observation } = await executeObservedTellAkuma(input);
  const { subject, pending } = observedTellEvidence(input.id, receipt);
  if (observation.kind === "unanswered" || observation.kind === "deadline")
    return { ...subject, ...pending, ...observation };
  return observation.kind === "answered" && input.schemaJson !== undefined
    ? { ...subject, ...observation, answer: JSON.parse(observation.answer) }
    : { ...subject, ...observation };
}

async function executeObservedTellAkuma(input: AskExecutionInput) {
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
