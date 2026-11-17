import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  executionProgress,
  waitForObservation,
  type WaitStatusObservation,
  type WaitReason,
  type OutcomeObserver,
} from "./akuma-observe.js";
import { pathsForAkumaId } from "./identity.js";
import type { AkumaStatus } from "./akuma.js";
import type { AkumaWaitItem, AkumaWaitOutcome } from "./selection-observation.js";
import { projectFact, type OutcomeRow } from "./projection.js";
import { frontierRows } from "./projection-read.js";

export type NativeWaitResult = Readonly<{ reason: WaitReason; results: readonly AkumaWaitItem[] }>;
export const AKUMA_WAIT_POLL_MS = 250;

function waitOutcome(row: OutcomeRow): AkumaWaitOutcome {
  return { ...row.outcome, historyId: `turn/${row.turnSequence}` };
}

function completionItem(snapshot: WaitStatusObservation): AkumaWaitItem {
  const end = snapshot.outcome;
  const row = end === undefined ? undefined : (projectFact(end) as OutcomeRow);
  const events =
    snapshot.activity === undefined || snapshot.life !== "running"
      ? undefined
      : frontierRows(snapshot.activity.map(projectFact)).slice(-3);
  return {
    kind: "observed",
    id: snapshot.id,
    life: snapshot.life,
    ...(snapshot.lastActivityAt === null ? {} : { lastActivityAt: snapshot.lastActivityAt }),
    ...(snapshot.hasPendingTell ? { pending: true } : {}),
    ...(row === undefined ? {} : { outcome: waitOutcome(row) }),
    ...(events === undefined ? {} : { events }),
    ...(snapshot.activityDiagnostic === undefined
      ? {}
      : { eventsUnavailable: diagnostic(snapshot.activityDiagnostic) }),
  };
}

/** One compact native observer supplies every set-wait caller. */
export function createAkumaWaitObserver(path: WorldRoot, selected: readonly AkumaStatus["id"][]) {
  const ids = [...new Set(selected)];
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
  const satisfied = (id: AkumaStatus["id"]) => {
    const item = items.get(id);
    return (
      item?.kind === "missing" ||
      (item?.kind === "observed" && executionProgress(item.life, item.pending === true) !== "advancing")
    );
  };
  return {
    items,
    satisfied,
    async observe(signal?: AbortSignal, recent = false): Promise<void> {
      for (const id of ids) {
        signal?.throwIfAborted();
        try {
          items.set(id, completionItem(await readerFor(id).wait(recent, signal)));
        } catch (error) {
          signal?.throwIfAborted();
          items.set(
            id,
            error instanceof AkumaNotBornError
              ? { kind: "missing", id }
              : { kind: "unobserved", id, diagnostic: diagnostic(error) },
          );
        }
      }
    },
    unavailableRecent(message: string): void {
      for (const [id, item] of items) {
        if (item.kind === "observed" && item.life === "running" && item.events === undefined)
          items.set(id, { ...item, eventsUnavailable: diagnostic(message) });
      }
    },
    async probe(completion: "any" | "all", signal?: AbortSignal): Promise<boolean> {
      let completed = 0;
      for (const id of ids) {
        signal?.throwIfAborted();
        let ready = false;
        try {
          ready = await readerFor(id).complete(signal);
        } catch (error) {
          signal?.throwIfAborted();
          ready = error instanceof AkumaNotBornError;
        }
        if (!ready) continue;
        if (completion === "any") return true;
        completed += 1;
      }
      return ids.length > 0 && completed === ids.length;
    },
    async notify(observer?: OutcomeObserver): Promise<void> {
      await Promise.all(
        [...items.values()].map(async (item) => {
          if (item.kind === "observed" && item.outcome !== undefined)
            await observer?.(item.id, [item.outcome.historyId]);
        }),
      );
    },
    clear(): void {
      for (const reader of readers.values()) reader.clear();
    },
  };
}

export async function executeWaitAkuma(
  input: Readonly<{
    path: WorldRoot;
    ids: readonly AkumaStatus["id"][];
    completion: "any" | "all";
    timeoutMs?: number;
    signal?: AbortSignal;
    outcomeObserved?: OutcomeObserver;
  }>,
): Promise<NativeWaitResult> {
  const ids = [...new Set(input.ids)];
  const observer = createAkumaWaitObserver(input.path, ids);
  try {
    const waited = await waitForObservation({
      pollMs: AKUMA_WAIT_POLL_MS,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      probe: () => observer.probe(input.completion, input.signal),
      observe: async () => {
        await observer.observe(input.signal);
        return ids.map((id) => observer.items.get(id)!);
      },
      complete: () =>
        ids.length > 0 && (input.completion === "any" ? ids.some(observer.satisfied) : ids.every(observer.satisfied)),
    });
    await observer.notify(input.outcomeObserved);
    return { reason: waited.reason, results: waited.value };
  } finally {
    observer.clear();
  }
}

function diagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 500)}...`;
}
