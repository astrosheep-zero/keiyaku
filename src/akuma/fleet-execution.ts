import { AkumaNotBornError, defaultWaitComplete, type AkumaStatus } from "./akuma.js";
import { createAkumaProduct } from "./akuma-product.js";
import { readBudgetedStatus, readWaitComplete } from "./akuma-observe.js";
import { NO_DISPATCH_ASSOCIATION } from "./dispatch-association.js";
import { EMPTY_CREATED_TASK_OBSERVATION } from "../task/created-observation.js";
import type { WorldRoot } from "../world.js";
import {
  fleetResultSchemas,
  parseAkumaObservation,
  type AkumaKillResult,
  type AkumaTellResult,
  type AkumaUnobserved,
  type AkumaWaitResult,
} from "./fleet-observation.js";

function source(path: WorldRoot) {
  return createAkumaProduct(path);
}

function observationDiagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SHARED_ORDINARY_BUDGET = 30;
const POLL_MS = 100;

type WaitRound = Readonly<{
  statuses: readonly AkumaStatus[];
  unobserved: readonly AkumaUnobserved[];
}>;

function akumaOnlyObservation(status: AkumaStatus) {
  return parseAkumaObservation({
    status,
    contract: NO_DISPATCH_ASSOCIATION,
    createdTasks: EMPTY_CREATED_TASK_OBSERVATION,
  });
}

async function observeWaitRound(
  path: WorldRoot,
  ids: readonly AkumaStatus["id"][],
  signal?: AbortSignal,
): Promise<WaitRound> {
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    return {
      statuses: await Promise.all(ids.map(async (id) => await source(path).selectHandle({ id }).status())),
      unobserved: [],
    };
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const statuses: AkumaStatus[] = [];
  const unobserved: AkumaUnobserved[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await readBudgetedStatus(path, id, { aperture: "monitoring", ordinaryBudget: remaining });
      statuses.push(observed.status);
      remaining -= observed.ordinarySelected;
    } catch (error) {
      if (error instanceof AkumaNotBornError) throw error;
      unobserved.push({ id, diagnostic: observationDiagnostic(error) });
    }
  }
  return { statuses, unobserved };
}

async function probeWaitRound(input: WaitExecutionInput): Promise<boolean> {
  let observed = 0;
  let complete = 0;
  for (const id of input.ids) {
    input.signal?.throwIfAborted();
    try {
      if (await readWaitComplete(input.path, id)) complete += 1;
      observed += 1;
    } catch (error) {
      if (input.ids.length <= 1 || error instanceof AkumaNotBornError) throw error;
      // Plural wait retries unreadable members; final rendering owns diagnostics.
    }
  }
  return observed > 0 && (input.completion === "any" ? complete > 0 : complete === input.ids.length);
}

function roundComplete(round: WaitRound, completion: "any" | "all"): boolean {
  const settled = round.statuses.map(defaultWaitComplete);
  return (
    settled.length > 0 &&
    (completion === "any" ? settled.some(Boolean) : round.unobserved.length === 0 && settled.every(Boolean))
  );
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const done = (): void => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("upstream request aborted"));
    };
    timer = setTimeout(done, milliseconds);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export async function executeWaitAkuma(input: WaitExecutionInput): Promise<AkumaWaitResult> {
  const deadline = input.timeoutMs === undefined ? undefined : performance.now() + input.timeoutMs;
  for (;;) {
    if ((deadline !== undefined && performance.now() >= deadline) || (await probeWaitRound(input))) {
      const round = await observeWaitRound(input.path, input.ids, input.signal);
      input.signal?.throwIfAborted();
      // The probe is not a completion receipt. Judge the actual returned values.
      if (roundComplete(round, input.completion) || (deadline !== undefined && performance.now() >= deadline)) {
        return fleetResultSchemas.wait.parse({
          completion: input.completion,
          observations: round.statuses.map(akumaOnlyObservation),
          unobserved: round.unobserved,
        });
      }
    }
    await delay(
      deadline === undefined ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - performance.now())),
      input.signal,
    );
  }
}

export type TellExecutionInput = Readonly<{
  path: WorldRoot;
  id: AkumaStatus["id"];
  body: string;
  tellId?: string;
  recordedAt?: string;
  signal?: AbortSignal;
}>;

export async function executeTellAkuma(input: TellExecutionInput): Promise<AkumaTellResult> {
  input.signal?.throwIfAborted();
  const handle = source(input.path).selectHandle({ id: input.id });
  const tell =
    input.tellId === undefined
      ? await handle.tell(input.body)
      : await handle.tell(input.body, input.tellId, input.recordedAt);
  input.signal?.throwIfAborted();
  return fleetResultSchemas.tell.parse({
    akuma: input.id,
    tell,
  });
}

export type KillExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  signal?: AbortSignal;
}>;

export async function executeKillAkuma(input: KillExecutionInput): Promise<AkumaKillResult> {
  input.signal?.throwIfAborted();
  const handles = input.ids.map((id) => source(input.path).selectHandle({ id }));
  const evidence = await Promise.all(
    handles.map(async (handle) => await handle.kill(input.signal === undefined ? {} : { signal: input.signal })),
  );
  input.signal?.throwIfAborted();
  return fleetResultSchemas.kill.parse({
    results: input.ids.map((id, index) => ({ id, evidence: evidence[index]! })),
  });
}
