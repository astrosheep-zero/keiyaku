import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  defaultWaitComplete,
  executionProgress,
  readWaitComplete,
  waitForObservation,
  type LiveStatusObservation,
  type WaitStatusObservation,
  type WaitReason,
  type OutcomeObserver,
} from "./akuma-observe.js";
import { pathsForAkumaId } from "./identity.js";
import type { AkumaStatus } from "./akuma.js";
import type { AkumaUnobserved, AkumaWaitItem, AkumaWaitOutcome } from "./selection-observation.js";
import { projectTurns, type OutcomeRow } from "./projection.js";

type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal custom completion judge over the full final observation where supplied. */
  predicate?: (status: LiveStatusObservation["status"]) => boolean;
  outcomeObserved?: OutcomeObserver;
}>;

/** One wait's association-free native evidence; upper composition attaches cross-product context. */
export type NativeWaitResult = Readonly<{
  reason: WaitReason;
  observations: readonly LiveStatusObservation["status"][];
  results: readonly AkumaWaitItem[];
}>;

type WaitRound = Readonly<{
  observations: readonly LiveStatusObservation[];
  unobserved: readonly AkumaUnobserved[];
  missing: readonly AkumaStatus["id"][];
}>;

const SHARED_ORDINARY_BUDGET = 30;
export const AKUMA_WAIT_POLL_MS = 250;

async function observeWaitRound(
  ids: readonly AkumaStatus["id"][],
  readerFor: (id: AkumaStatus["id"]) => ReturnType<typeof createLiveStatusReader>,
  signal?: AbortSignal,
  witnessed?: (item: AkumaWaitItem) => void,
  mode = { lightweight: false, recent: false },
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
      if (mode.lightweight) {
        const item = completionSnapshot(await readerFor(id).wait(mode.recent, signal));
        witnessed?.(item);
      } else {
        const observed = await read(id, remaining);
        observations.push(observed);
        witnessed?.(completionItem(observed));
        remaining -= observed.ordinarySelected;
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AkumaNotBornError) {
        missing.push(id);
        witnessed?.({ kind: "missing", id });
      } else {
        const item = { id, diagnostic: diagnostic(error) };
        unobserved.push(item);
        witnessed?.({ kind: "unobserved", ...item });
      }
    }
  }
  return { observations, unobserved, missing };
}

function roundComplete(
  round: WaitRound,
  completion: "any" | "all",
  predicate?: (status: LiveStatusObservation["status"]) => boolean,
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
    ...(status.lastActivityAt === undefined ? {} : { lastActivityAt: status.lastActivityAt }),
    ...(pending ? { pending: true } : {}),
    ...(outcome === undefined ? {} : { outcome: waitOutcome(outcome) }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
  };
}

function completionSnapshot(snapshot: WaitStatusObservation): AkumaWaitItem {
  const turn = snapshot.turn;
  const outcome = turn?.end === undefined ? undefined : projectTurns([turn, turn.end]).latestOutcome;
  let events;
  let eventsUnavailable = snapshot.activityDiagnostic;
  if (snapshot.activity !== undefined && snapshot.life === "running") {
    try {
      events = projectTurns(snapshot.activity.rows).rows.slice(-3);
    } catch (error) {
      eventsUnavailable = diagnostic(error);
    }
  }
  return {
    kind: "observed",
    id: snapshot.id,
    life: snapshot.life,
    ...(snapshot.lastActivityAt === null ? {} : { lastActivityAt: snapshot.lastActivityAt }),
    ...(snapshot.hasPendingTell ? { pending: true } : {}),
    ...(outcome === undefined ? {} : { outcome: waitOutcome(outcome) }),
    ...(events === undefined ? {} : { events }),
    ...(eventsUnavailable === undefined ? {} : { eventsUnavailable: diagnostic(eventsUnavailable) }),
  };
}

/** Private observation custody shared by native and invocation set waits. */
export function createAkumaWaitObserver(path: WorldRoot, ids: readonly AkumaStatus["id"][], lightweight = false) {
  const readers = new Map<AkumaStatus["id"], ReturnType<typeof createLiveStatusReader>>();
  const items = new Map<AkumaStatus["id"], AkumaWaitItem>();
  const readerFor = (id: AkumaStatus["id"]) => {
    let reader = readers.get(id);
    if (reader === undefined) {
      reader = createLiveStatusReader(pathsForAkumaId(path, id), id);
      readers.set(id, reader);
    }
    return reader;
  };
  return {
    items,
    satisfied: (id: AkumaStatus["id"]) => {
      const item = items.get(id);
      return item?.kind === "observed" && executionProgress(item.life, item.pending === true) !== "advancing";
    },
    observe: (signal?: AbortSignal, recent = false) =>
      observeWaitRound(ids, readerFor, signal, (item) => items.set(item.id, item), { lightweight, recent }),
    unavailableRecent(message: string): void {
      for (const [id, item] of items) {
        if (item.kind === "observed" && item.life === "running" && item.events === undefined)
          items.set(id, { ...item, eventsUnavailable: diagnostic(message) });
      }
    },
    probe: (completion: "any" | "all", signal?: AbortSignal) =>
      readWaitComplete(path, ids, completion, signal, (id) =>
        readerFor(id)
          .complete(signal)
          .catch((error: unknown) => {
            if (error instanceof AkumaNotBornError) return true;
            throw error;
          }),
      ),
    async notify(observer?: OutcomeObserver): Promise<void> {
      for (const item of items.values()) {
        if (item.kind === "observed" && item.outcome !== undefined) await observer?.(item.id, [item.outcome.historyId]);
      }
    },
    clear: () => {
      for (const reader of readers.values()) reader.clear();
    },
  };
}

/** Compact final native evidence, retaining full statuses privately for owner composition. */
export async function executeWaitAkuma(input: WaitExecutionInput): Promise<NativeWaitResult> {
  const observer = createAkumaWaitObserver(input.path, input.ids);
  try {
    const waited = await waitForObservation({
      pollMs: AKUMA_WAIT_POLL_MS,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.predicate === undefined
        ? {
            probe: () => observer.probe(input.completion, input.signal),
          }
        : {}),
      observe: () => observer.observe(input.signal),
      complete: (round) => roundComplete(round, input.completion, input.predicate),
    });
    await observer.notify(input.outcomeObserved);
    return {
      reason: waited.reason,
      observations: waited.value.observations.map((observation) => observation.status),
      results: input.ids.map((id) => observer.items.get(id)!),
    };
  } finally {
    observer.clear();
  }
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 500)}...`;
}
