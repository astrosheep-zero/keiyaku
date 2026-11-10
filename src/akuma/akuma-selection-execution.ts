import { z } from "zod";
import { akumaStatusSchema } from "./akuma.js";
import { activityRowSchema } from "./projection.js";
import { tellResultSchema } from "./call-initial-tell.js";
import { akumaIdSchema } from "./identity.js";
import type { WorldRoot } from "../world.js";
import { AkumaNotBornError, AkumaProviderError } from "./akuma-errors.js";
import type { LiveStatusObservation, OutcomeObserver } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import type { AkumaStatus } from "./akuma.js";
import { tellWakeRuntime, type TellResult } from "./body.js";
import type { BodyLauncher } from "./body-launch.js";
import {
  compactTellResult,
  type AkumaAskObservation,
  type AkumaAskResult,
  type AkumaKillResult,
  type AkumaTellResult,
} from "./selection-observation.js";

export const liveStatusObservationSchema = z
  .strictObject({
    status: akumaStatusSchema,
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
    return {
      akumaId,
      tellId,
      ...(wake === undefined ? {} : { wake }),
      ...(interrupt === undefined ? {} : { interrupt }),
      input:
        observation.kind === "invalid-output" ? { kind: "failed", diagnostic: observation.diagnostic } : observation,
    };
  }
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  let tell;
  if (input.interrupt === true) {
    const interrupted = await owner.interrupt(input.body, {
      runtime: tellWakeRuntime(input.spawn),
      ...(input.tellId === undefined ? {} : { tellId: input.tellId }),
      ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if ("kind" in interrupted) throw new AkumaProviderError(`Tell interrupt unavailable: ${interrupted.evidence}`);
    tell = interrupted;
  } else {
    tell = await owner.tell(input.body, input.tellId, input.recordedAt, tellWakeRuntime(input.spawn), {
      ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }
  input.signal?.throwIfAborted();
  const { interrupt, ...compact } = compactTellResult(input.id, tell);
  if (interrupt?.kind === "pending") throw new Error("Tell returned an unsettled interruption");
  return { ...compact, ...(interrupt === undefined ? {} : { interrupt }) };
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
  const observed = await owner.tellOutcome(input.tellId, {
    wake: () => {
      if (wakeError !== undefined) throw wakeError.error;
      return wakeState;
    },
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: Math.max(0, input.timeoutMs - elapsed) }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onObserve?.observe === undefined ? {} : { observe: input.onObserve.observe }),
  });
  const receipt = compactTellResult(input.id, settled ?? tell);
  const observation = askObservation(observed);
  const { wake, ...subject } = receipt;
  return observation.kind === "unanswered" || observation.kind === "deadline"
    ? { ...subject, ...(wake === undefined ? {} : { wake }), ...observation }
    : { ...subject, ...(wake?.kind === "failed" ? { wake } : {}), ...observation };
}

/**
 * The interrupt half of Ask: admit the Tell together with its yield request,
 * then observe the answer bound to that same admission. Kept out of the public
 * operation so ordinary and interrupted admission each read as one flow; both
 * share `observeAdmittedAskAkuma`.
 */
async function executeInterruptAskAkuma(
  input: AskExecutionInput,
  owner: AkumaOwner,
): Promise<AkumaAskResult & { answer?: string }> {
  const admission = await owner.admitInterrupt(input.body, {
    ...(input.tellId === undefined ? {} : { tellId: input.tellId }),
    ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
    ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (admission.kind === "unavailable")
    throw new AkumaProviderError(`Tell interrupt unavailable: ${admission.evidence}`);
  const observing = new AbortController();
  const signal = input.signal === undefined ? observing.signal : AbortSignal.any([input.signal, observing.signal]);
  const wake = owner.completeInterruptAdmission(admission, tellWakeRuntime(input.spawn), signal);
  try {
    const receipt =
      admission.barrier === undefined
        ? undefined
        : {
            ...(await owner.admittedReceipt(admission.tell.id)),
            interruption: { kind: "pending" as const, bodySequence: admission.barrier.bodySequence },
          };
    return await observeAdmittedAskAkuma({
      path: input.path,
      id: input.id,
      tellId: admission.tell.id,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      startedAt: performance.now(),
      wake,
      ...(receipt === undefined ? {} : { receipt }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.onObserve === undefined ? {} : { onObserve: input.onObserve }),
      ...(input.outcomeObserved === undefined ? {} : { outcomeObserved: input.outcomeObserved }),
    });
  } finally {
    if (!observing.signal.aborted) observing.abort(new Error("interrupt observation ended"));
    await wake.catch(() => undefined);
  }
}

export async function executeAskAkuma(input: AskExecutionInput): Promise<AkumaAskResult & { answer?: string }> {
  input.signal?.throwIfAborted();
  const owner = new AkumaOwner(input.id, input.path);
  if (input.interrupt === true) return await executeInterruptAskAkuma(input, owner);

  const admission = await owner.admitTell(input.body, input.tellId, input.recordedAt, tellWakeRuntime(input.spawn), {
    ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
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
    ...(input.outcomeObserved === undefined ? {} : { outcomeObserved: input.outcomeObserved }),
  });
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
