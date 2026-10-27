import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  defaultWaitComplete,
  readWaitComplete,
  waitForObservation,
  type LiveStatusObservation,
  type WaitReason,
} from "./akuma-observe.js";
import { pathsForAkuId } from "./identity.js";
import type { AkumaStatus } from "./akuma.js";
import type { AkumaUnobserved } from "./selection-observation.js";

type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal custom completion judge over the full final observation where supplied. */
  predicate?: (status: AkumaStatus) => boolean;
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
  ids: readonly AkumaStatus["id"][],
  readerFor: (id: AkumaStatus["id"]) => ReturnType<typeof createLiveStatusReader>,
  signal?: AbortSignal,
): Promise<WaitRound> {
  const read = (id: AkumaStatus["id"], ordinaryBudget?: number) =>
    readerFor(id).read({ aperture: "monitoring", ...(ordinaryBudget === undefined ? {} : { ordinaryBudget }) }, signal);
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    const observations = await Promise.all(ids.map(async (id) => await read(id)));
    return { observations, unobserved: [] };
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const observations: LiveStatusObservation[] = [];
  const unobserved: AkumaUnobserved[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await read(id, remaining);
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

/** Wait observes completion and returns final status snapshots, never a live stream. */
export async function executeWaitAkuma(input: WaitExecutionInput): Promise<NativeWaitResult> {
  const readers = new Map<AkumaStatus["id"], ReturnType<typeof createLiveStatusReader>>();
  const readerFor = (id: AkumaStatus["id"]) => {
    let reader = readers.get(id);
    if (reader === undefined) {
      reader = createLiveStatusReader(pathsForAkuId(input.path, id), id);
      readers.set(id, reader);
    }
    return reader;
  };
  try {
    const waited = await waitForObservation({
      pollMs: 250,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.predicate === undefined
        ? {
            probe: async () =>
              await readWaitComplete(input.path, input.ids, input.completion, input.signal, (id) =>
                readerFor(id).complete(input.signal),
              ),
          }
        : {}),
      observe: async () => await observeWaitRound(input.ids, readerFor, input.signal),
      complete: (round) => roundComplete(round, input.completion, input.predicate),
    });
    return {
      mode: input.completion,
      reason: waited.reason,
      observations: waited.value.observations.map((observation) => observation.status),
      unobserved: waited.value.unobserved,
    };
  } finally {
    for (const reader of readers.values()) reader.clear();
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
