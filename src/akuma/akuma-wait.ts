import { z } from "zod";
import { boundedDiagnostic as diagnostic } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  waitComplete,
  waitForObservation,
  type WaitStatusObservation,
  type WaitReason,
  type OutcomeObserver,
} from "./akuma-observe.js";
import { pathsForAkumaId, reportHistoryIdSchema, type AkumaId } from "./identity.js";
import type { WaitReportFrontier } from "./heart/index.js";
import { UnsupportedHistoricalHeartError } from "./heart/schema.js";
import type { AkumaStatus } from "./akuma.js";
import type { AkumaWaitItem, AkumaWaitOutcome } from "./selection-observation.js";
import { projectFact, type OutcomeRow } from "./projection.js";
import { frontierTail } from "./status-projection.js";
import { clipActionText } from "./timeline-text.js";

export type NativeWaitResult = Readonly<{ reason: WaitReason; results: readonly AkumaWaitItem[] }>;
export const AKUMA_WAIT_POLL_MS = 250;

export const waitReportSchema = z.strictObject({ report: reportHistoryIdSchema, text: z.string() }).readonly();
type WaitReport = Readonly<{ id: AkumaId; preview: z.output<typeof waitReportSchema> }>;

function waitOutcome(row: OutcomeRow): AkumaWaitOutcome {
  return { ...row.outcome, historyId: `turn/${row.turnSequence}` };
}

function completionItem(snapshot: WaitStatusObservation): AkumaWaitItem {
  const end = snapshot.outcome;
  const row = end === undefined ? undefined : (projectFact(end) as OutcomeRow);
  const running = snapshot.life === "running";
  const rows = running ? snapshot.activity?.map(projectFact) : undefined;
  const turn = rows?.findLast((item) => item.kind === "turn");
  const events =
    rows === undefined
      ? undefined
      : turn !== undefined && turn.bodySequence === snapshot.latestBody?.sequence && end?.turnSequence !== turn.sequence
        ? frontierTail(rows)
        : [];
  return {
    kind: "observed",
    id: snapshot.id,
    life: snapshot.life,
    ...(snapshot.lastActivityAt === null ? {} : { lastActivityAt: snapshot.lastActivityAt }),
    ...(snapshot.hasPendingTell ? { pending: true } : {}),
    ...(row === undefined ? {} : { outcome: waitOutcome(row) }),
    ...(events === undefined ? {} : { events }),
    ...(!running || snapshot.activityDiagnostic === undefined
      ? {}
      : { eventsUnavailable: diagnostic(snapshot.activityDiagnostic) }),
  };
}

async function probeCompletion(
  ids: readonly AkumaId[],
  readerFor: (id: AkumaId) => ReturnType<typeof createLiveStatusReader>,
  completion: "any" | "all",
  signal: AbortSignal | undefined,
): Promise<boolean> {
  let completed = 0;
  for (const id of ids) {
    signal?.throwIfAborted();
    let ready = false;
    try {
      ready = await readerFor(id).complete(signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof UnsupportedHistoricalHeartError) throw error;
      ready = error instanceof AkumaNotBornError;
    }
    if (!ready) continue;
    if (completion === "any") return true;
    completed += 1;
  }
  return ids.length > 0 && completed === ids.length;
}

/** One compact native observer supplies every set-wait caller; only invocation tracks reports. */
export function createAkumaWaitObserver(
  path: WorldRoot,
  selected: readonly AkumaId[],
  { includeRecent = false, trackReports = false }: Readonly<{ includeRecent?: boolean; trackReports?: boolean }> = {},
) {
  const ids = [...new Set(selected)];
  const readers = new Map<AkumaId, ReturnType<typeof createLiveStatusReader>>();
  const items = new Map<AkumaId, AkumaWaitItem>();
  const watermarks = trackReports ? new Map<AkumaId, number>() : undefined;
  let report: WaitReport | undefined;
  const reportAfter = (id: AkumaId) =>
    watermarks === undefined || report !== undefined ? undefined : (watermarks.get(id) ?? null);
  const observeReport = (id: AkumaId, frontier: WaitReportFrontier): void => {
    if (watermarks === undefined || frontier === undefined) return;
    if (!watermarks.has(id)) watermarks.set(id, frontier.sequence);
    if (frontier.report !== undefined) {
      const { sequence, text } = frontier.report;
      report = { id, preview: { report: `report/${sequence}`, text: clipActionText(text).text } };
    }
  };
  const readerFor = (id: AkumaStatus["id"]) => {
    let reader = readers.get(id);
    if (reader === undefined) {
      reader = createLiveStatusReader(pathsForAkumaId(path, id), id);
      readers.set(id, reader);
    }
    return reader;
  };
  const satisfied = (id: AkumaId) => {
    const item = items.get(id);
    return item?.kind === "missing" || (item?.kind === "observed" && waitComplete(item.life, item.pending === true));
  };
  const observe = async (signal?: AbortSignal, paced = false): Promise<void> => {
    for (const id of ids) {
      signal?.throwIfAborted();
      try {
        const skipAdvancing = paced && items.get(id)?.kind === "observed" && !satisfied(id);
        const snapshot = await readerFor(id).wait(includeRecent, reportAfter(id), skipAdvancing, signal);
        observeReport(id, snapshot.reportFrontier);
        // Keep an earlier coherent observation of advancing work rather than mixing it with a thin probe.
        if (snapshot.outcomeRead) items.set(id, completionItem(snapshot));
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof UnsupportedHistoricalHeartError) throw error;
        items.set(
          id,
          error instanceof AkumaNotBornError
            ? { kind: "missing", id }
            : { kind: "unobserved", id, diagnostic: diagnostic(error) },
        );
      }
    }
  };
  return {
    items,
    satisfied,
    reported: () => report,
    observe: (signal?: AbortSignal) => observe(signal),
    observePaced: (signal: AbortSignal) => observe(signal, true),
    probe: (completion: "any" | "all", signal?: AbortSignal) => probeCompletion(ids, readerFor, completion, signal),
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
