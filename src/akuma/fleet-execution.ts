import {
  Akuma,
  AkumaNotBornError,
  defaultWaitComplete,
  type AkumaStatus,
} from "./akuma.js";
import { readBudgetedStatus, tellAkumaWithId } from "./akuma.js";
import { NO_DISPATCH_ASSOCIATION } from "../dispatch/association.js";
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

function source(path: WorldRoot): Akuma {
  return Akuma.of(path);
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
      statuses: await Promise.all(ids.map(async (id) => await source(path).of({ id }).status())),
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
    const round = await observeWaitRound(input.path, input.ids, input.signal);
    const settled = round.statuses.map(defaultWaitComplete);
    const completed =
      round.statuses.length > 0 &&
      (input.completion === "any" ? settled.some(Boolean) : round.unobserved.length === 0 && settled.every(Boolean));
    if (completed || (deadline !== undefined && performance.now() >= deadline)) {
      return fleetResultSchemas.wait.parse({
        completion: input.completion,
        observations: round.statuses.map(akumaOnlyObservation),
        unobserved: round.unobserved,
      });
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
  const handle = source(input.path).of({ id: input.id });
  const tell =
    input.tellId === undefined
      ? await handle.tell(input.body)
      : await tellAkumaWithId({
          worldPath: input.path,
          id: input.id,
          body: input.body,
          tellId: input.tellId,
          ...(input.recordedAt === undefined ? {} : { recordedAt: input.recordedAt }),
        });
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
  const handles = input.ids.map((id) => source(input.path).of({ id }));
  const evidence = await Promise.all(handles.map(async (handle) => await handle.kill()));
  input.signal?.throwIfAborted();
  return fleetResultSchemas.kill.parse({
    results: input.ids.map((id, index) => ({ id, evidence: evidence[index]! })),
  });
}
