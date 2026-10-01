import type { WorldRoot } from "../world.js";
import { AkumaNotBornError, AkumaProviderError } from "./akuma-errors.js";
import type { LiveStatusObservation } from "./akuma-observe.js";
import { AkumaOwner } from "./akuma-owner.js";
import type { AkumaStatus } from "./akuma.js";
import type { TellResult } from "./body.js";
import type { Schema } from "./schema.js";
import type { AkumaAskObservation, AkumaAskResult, AkumaKillResult, AkumaTellResult } from "./selection-observation.js";

export type AskObserver = Readonly<{
  admitted?: (tell: TellResult, id: AkumaStatus["id"]) => void | Promise<void>;
  observe?: (observation: LiveStatusObservation) => void | Promise<void>;
}>;

type TellExecutionInput = Readonly<{
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

type KillExecutionInput = Readonly<{
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
