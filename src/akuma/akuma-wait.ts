import { z } from "zod";
import { boundedDiagnostic as diagnostic } from "../settings.js";
import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  createLiveStatusReader,
  waitComplete,
  OBSERVATION_POLL_MS,
  type WaitStatusObservation,
  type WaitReason,
  type OutcomeObserver,
} from "./akuma-observe.js";
import { pathsForAkumaId, reportHistoryIdSchema, type AkumaId } from "./identity.js";
import type { WaitFacts, WaitReportFrontier } from "./heart/index.js";
import { UnsupportedHistoricalHeartError } from "./heart/schema.js";
import type { AkumaStatus } from "./akuma.js";
import type { AkumaWaitItem } from "./selection-observation.js";
import { projectFact, projectSettledTurn } from "./projection.js";
import { abortableDelay } from "./abort.js";
import { clipActionText, compactTimelineItem } from "./timeline-text.js";

export type NativeWaitResult = Readonly<{ reason: WaitReason; results: readonly AkumaWaitItem[] }>;

export const waitReportSchema = z
  .strictObject({ report: reportHistoryIdSchema, text: z.string() })
  .readonly()
  .meta({ id: "WaitReport" });
type WaitReport = Readonly<{ id: AkumaId; preview: z.output<typeof waitReportSchema> }>;

export function isWaitAbort(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if (error === signal.reason) return true;
  if (error instanceof AggregateError)
    return error.errors.length > 0 && error.errors.every((reason) => isWaitAbort(reason, signal));
  return error instanceof Error && error.cause !== undefined && isWaitAbort(error.cause, signal);
}

export function startWaitClock(timeoutMs: number | undefined, caller?: AbortSignal, startedAt = performance.now()) {
  const deadline = timeoutMs === undefined ? Infinity : startedAt + timeoutMs;
  const stop = new AbortController();
  const signal = caller === undefined ? stop.signal : AbortSignal.any([caller, stop.signal]);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let exhausted = false;
  const remaining = () => deadline - performance.now();
  function expire(): void {
    exhausted = true;
    stop.abort();
  }
  function schedule(): void {
    const left = remaining();
    if (left <= 0) expire();
    else timeout = setTimeout(schedule, Math.min(left, 2_147_483_647));
  }
  function beforeRead(): void {
    if (timeoutMs !== 0 && remaining() <= 0) expire();
    signal.throwIfAborted();
  }
  // A requested zero still grants the one initial observation.
  if (timeoutMs !== undefined && timeoutMs > 0) schedule();
  return {
    signal,
    stop,
    remaining,
    beforeRead,
    startedAt,
    expired: () => exhausted,
    close: () => clearTimeout(timeout),
  };
}

function completionItem(snapshot: WaitStatusObservation, includeTail: boolean): AkumaWaitItem {
  const { id: akuma, life, outcome, lastActivityAt, openTurn, activity, activityDiagnostic } = snapshot;
  const subject = { akuma, ...(lastActivityAt === null ? {} : { lastActivityAt }) };
  const last = outcome === undefined ? undefined : projectSettledTurn(outcome);
  const history = last === undefined ? {} : { last };
  if (life === "running")
    return {
      ...subject,
      ...history,
      state: "running",
      ...(openTurn === undefined ? {} : { turn: `turn/${openTurn}` as const }),
      ...(includeTail
        ? {
            events:
              activityDiagnostic === undefined
                ? (activity ?? []).map((fact) => compactTimelineItem(projectFact(fact)))
                : { reason: diagnostic(activityDiagnostic) },
          }
        : {}),
    };
  if (!waitComplete(life, snapshot.hasPendingTell)) return { ...subject, ...history, state: "waiting" };
  if (life === "asleep") return last === undefined ? { ...subject, state: "idle" } : { ...subject, ...last };
  return {
    ...subject,
    ...history,
    state: life === "killed" ? "canceled" : "failed",
    reason: snapshot.latestBody?.hung?.diagnostic ?? life,
  };
}

type RetainedWaitEvidence = { outcome?: NonNullable<WaitFacts["outcome"]>; lastActivityAt?: string };

function unavailableWaitMember(
  akuma: AkumaId,
  { outcome, lastActivityAt }: RetainedWaitEvidence,
  error: unknown,
  stopped: boolean,
): AkumaWaitItem | undefined {
  if (outcome === undefined && lastActivityAt === undefined) {
    if (stopped) return undefined;
    if (error instanceof AkumaNotBornError) return { state: "missing", akuma };
  }
  return {
    state: "unavailable",
    akuma,
    ...(outcome === undefined ? {} : { last: projectSettledTurn(outcome) }),
    ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
    ...(stopped ? {} : { reason: diagnostic(error) }),
  };
}

async function notifyWaitOutcomes(items: Iterable<AkumaWaitItem>, observer?: OutcomeObserver): Promise<void> {
  await Promise.all(
    Array.from(items, async (item) => {
      const terminal =
        "last" in item ? item.last?.turn : item.state !== "running" && "turn" in item ? item.turn : undefined;
      if (terminal !== undefined) await observer?.(item.akuma, [terminal]);
    }),
  );
}

/** One compact native observer supplies every set-wait caller; only invocation tracks reports. */
export function createAkumaWaitObserver(
  path: WorldRoot,
  selected: readonly AkumaId[],
  includeInvocationDetail = false,
) {
  const ids = [...new Set(selected)];
  const readers = new Map<AkumaId, ReturnType<typeof createLiveStatusReader>>();
  const items = new Map<AkumaId, AkumaWaitItem>();
  const unavailable = new Map<AkumaId, unknown>();
  const watermarks = includeInvocationDetail ? new Map<AkumaId, number>() : undefined;
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
    return (
      item !== undefined &&
      item.state !== "missing" &&
      item.state !== "unavailable" &&
      item.state !== "running" &&
      item.state !== "waiting"
    );
  };
  const observe = async (signal?: AbortSignal, beforeRead = () => signal?.throwIfAborted()): Promise<void> => {
    for (const id of ids) {
      beforeRead();
      const witnessed: RetainedWaitEvidence = {};
      try {
        const snapshot = await readerFor(id).wait(
          includeInvocationDetail,
          reportAfter(id),
          signal,
          beforeRead,
          ({ outcome, lastActivityAt, reportFrontier }) => {
            if (outcome !== undefined) witnessed.outcome = outcome;
            if (lastActivityAt !== null) witnessed.lastActivityAt = lastActivityAt;
            observeReport(id, reportFrontier);
          },
        );
        items.set(id, completionItem(snapshot, includeInvocationDetail));
        unavailable.delete(id);
      } catch (error) {
        if (error instanceof UnsupportedHistoricalHeartError) throw error;
        const stopped = signal !== undefined && isWaitAbort(error, signal);
        const member = unavailableWaitMember(id, witnessed, error, stopped);
        if (member !== undefined) items.set(id, member);
        if (stopped) throw error;
        if (member?.state === "unavailable") unavailable.set(id, error);
        else unavailable.delete(id);
      }
    }
  };
  return {
    items,
    satisfied,
    reported: () => report,
    unavailableCauses: () => unavailable.values(),
    observe,
    notify: (observer?: OutcomeObserver) => notifyWaitOutcomes(items.values(), observer),
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
  const clock = startWaitClock(input.timeoutMs, input.signal);
  const complete = () =>
    ids.length > 0 && (input.completion === "any" ? ids.some(observer.satisfied) : ids.every(observer.satisfied));
  try {
    try {
      do {
        await observer.observe(clock.signal, clock.beforeRead);
        if (
          complete() ||
          [...observer.items.values()].some((item) => item.state === "missing") ||
          clock.remaining() <= 0
        )
          break;
        await abortableDelay(Math.min(OBSERVATION_POLL_MS, clock.remaining()), clock.signal);
      } while (clock.remaining() > 0);
    } catch (error) {
      if (!clock.expired() || !isWaitAbort(error, clock.stop.signal)) throw error;
    }
    input.signal?.throwIfAborted();
  } finally {
    clock.close();
    observer.clear();
  }
  await observer.notify(input.outcomeObserved);
  return {
    reason: complete() ? "completed" : "deadline",
    results: ids.map((akuma) => observer.items.get(akuma) ?? { state: "unavailable", akuma }),
  };
}
