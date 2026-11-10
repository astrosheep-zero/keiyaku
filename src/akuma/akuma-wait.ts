import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  defaultWaitComplete,
  readWaitComplete,
  waitForObservation,
  type LiveStatusObservation,
  type WaitReason,
  type OutcomeObserver,
} from "./akuma-observe.js";
import { pathsForAkumaId } from "./identity.js";
import type { AkumaStatus } from "./akuma.js";
import type { AkumaUnobserved, AkumaWaitItem, AkumaWaitOutcome } from "./selection-observation.js";
import type { OutcomeRow } from "./projection.js";

type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal custom completion judge over the full final observation where supplied. */
  predicate?: (status: AkumaStatus) => boolean;
  outcomeObserved?: OutcomeObserver;
}>;

/** One wait's association-free native evidence; upper composition attaches cross-product context. */
export type NativeWaitResult = Readonly<{
  reason: WaitReason;
  observations: readonly AkumaStatus[];
  results: readonly AkumaWaitItem[];
}>;

type WaitRound = Readonly<{
  observations: readonly LiveStatusObservation[];
  unobserved: readonly AkumaUnobserved[];
  missing: readonly AkumaStatus["id"][];
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
  let remaining = SHARED_ORDINARY_BUDGET;
  const observations: LiveStatusObservation[] = [];
  const unobserved: AkumaUnobserved[] = [];
  const missing: AkumaStatus["id"][] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await read(id, remaining);
      observations.push(observed);
      remaining -= observed.ordinarySelected;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AkumaNotBornError) missing.push(id);
      else unobserved.push({ id, diagnostic: diagnostic(error) });
    }
  }
  return { observations, unobserved, missing };
}

function roundComplete(
  round: WaitRound,
  completion: "any" | "all",
  predicate?: (status: AkumaStatus) => boolean,
): boolean {
  const judge = predicate ?? defaultWaitComplete;
  const settled = [
    ...round.observations.map((observation) => judge(observation.status)),
    ...round.missing.map(() => true),
  ];
  return (
    settled.length > 0 &&
    (completion === "any" ? settled.some(Boolean) : round.unobserved.length === 0 && settled.every(Boolean))
  );
}

function waitOutcome(row: OutcomeRow): AkumaWaitOutcome {
  const historyId = `turn/${row.turnSequence}` as const;
  const outcome = row.outcome;
  return outcome.kind === "answered"
    ? { kind: "answered", historyId, answer: outcome.answer }
    : outcome.kind === "failed"
      ? { kind: "failed", historyId, diagnostic: outcome.diagnostic }
      : { kind: "canceled", historyId };
}

function completionItem({ status, rows }: LiveStatusObservation): AkumaWaitItem {
  const pending = status.timeline.entries.some(
    (entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
  );
  const outcome = rows.findLast((row): row is OutcomeRow => row.kind === "outcome");
  return {
    kind: "observed",
    id: status.id,
    life: status.life,
    ...(pending ? { pending: true } : {}),
    ...(outcome === undefined ? {} : { outcome: waitOutcome(outcome) }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
  };
}

/** Compact final native evidence, retaining full statuses privately for owner composition. */
export async function executeWaitAkuma(input: WaitExecutionInput): Promise<NativeWaitResult> {
  const readers = new Map<AkumaStatus["id"], ReturnType<typeof createLiveStatusReader>>();
  const readerFor = (id: AkumaStatus["id"]) => {
    let reader = readers.get(id);
    if (reader === undefined) {
      reader = createLiveStatusReader(pathsForAkumaId(input.path, id), id);
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
                readerFor(id)
                  .complete(input.signal)
                  .catch((error: unknown) => {
                    if (error instanceof AkumaNotBornError) return true;
                    throw error;
                  }),
              ),
          }
        : {}),
      observe: async () => await observeWaitRound(input.ids, readerFor, input.signal),
      complete: (round) => roundComplete(round, input.completion, input.predicate),
    });
    for (const { status, rows } of waited.value.observations) {
      const outcome = rows.findLast((row): row is OutcomeRow => row.kind === "outcome");
      if (outcome !== undefined) await input.outcomeObserved?.(status.id, [`turn/${outcome.turnSequence}`]);
    }
    const items = new Map<AkumaStatus["id"], AkumaWaitItem>(
      waited.value.observations.map((observation) => [observation.status.id, completionItem(observation)]),
    );
    for (const item of waited.value.unobserved) items.set(item.id, { kind: "unobserved", ...item });
    for (const id of waited.value.missing) items.set(id, { kind: "missing", id });
    return {
      reason: waited.reason,
      observations: waited.value.observations.map((observation) => observation.status),
      results: input.ids.map((id) => items.get(id)!),
    };
  } finally {
    for (const reader of readers.values()) reader.clear();
  }
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
