import { isDeepStrictEqual } from "node:util";
import { abortableDelay } from "./abort.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import { OBSERVATION_POLL_MS, type OutcomeObserver } from "./akuma-observe.js";
import { createTimelineReader } from "./heart/index.js";
import type { ActivityFactSlice } from "./heart/timeline.js";
import type { AkuId, AkumaPaths } from "./identity.js";
import { projectTurns, selectHistory, type ActivityHistory, type ActivityRow } from "./projection.js";

/** The complete bounded latest timeline window one stream emission carries; never a delta. */
export type AkumaStreamSnapshot = ActivityHistory;

/** The fixed number of projected rows one window retains. */
const STREAM_WINDOW = 500;

/**
 * The private end-of-observation reason. It is deliberately not the caller's
 * abort reason: a returned observation completes, while an aborted one keeps
 * the caller's own failure.
 */
const STREAM_RETURN = Symbol("akuma-stream-return");

function windowOf(slice: ActivityFactSlice): AkumaStreamSnapshot {
  return selectHistory(projectTurns(slice.rows, { lowestRetained: slice.lowestRetained, highest: slice.highest }), {
    limit: STREAM_WINDOW,
  });
}

/** The window to emit, or nothing when the observation still carries the same meaning. */
function changedWindow(
  previous: AkumaStreamSnapshot | undefined,
  slice: ActivityFactSlice,
): AkumaStreamSnapshot | undefined {
  const snapshot = windowOf(slice);
  return previous === undefined || !isDeepStrictEqual(snapshot, previous) ? snapshot : undefined;
}

/**
 * Announce each retained outcome identity once per observation, keeping only
 * the identities the current window still carries, so a long stream remembers
 * a bounded set rather than every outcome it ever saw.
 */
async function announceOutcomes(
  id: AkuId,
  rows: readonly ActivityRow[],
  observed: ReadonlySet<string>,
  observe?: OutcomeObserver,
): Promise<ReadonlySet<string>> {
  const outcomes = new Set(rows.flatMap((row) => (row.kind === "outcome" ? [row.outcome.historyId] : [])));
  const fresh = [...outcomes].filter((historyId) => !observed.has(historyId));
  if (fresh.length > 0) await observe?.(id, fresh);
  return outcomes;
}

/**
 * The observation loop itself. It decodes the retained timeline through the
 * existing Turn projection on every pull and answers with the whole latest
 * bounded window, holding only that window and one reader. Complete windows
 * coalesce; they are not lossless event delivery, and the existing retention
 * metadata keeps its honest meaning.
 */
async function* observeTimeline(
  paths: AkumaPaths,
  id: AkuId,
  signal: AbortSignal,
  observe?: OutcomeObserver,
): AsyncGenerator<AkumaStreamSnapshot> {
  const reader = createTimelineReader(paths);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    reader.clear();
  };
  let observedOutcomes: ReadonlySet<string> = new Set();
  let previous: AkumaStreamSnapshot | undefined;
  signal.addEventListener("abort", release, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const read = await reader.read(signal);
      signal.throwIfAborted();
      if (read.changed) {
        if (!read.born) throw new AkumaNotBornError(id);
        const snapshot = changedWindow(previous, read.slice);
        if (snapshot !== undefined) {
          observedOutcomes = await announceOutcomes(id, snapshot.rows, observedOutcomes, observe);
          previous = snapshot;
          yield snapshot;
        }
      }
      await abortableDelay(OBSERVATION_POLL_MS, signal);
    }
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
}

/**
 * The one continuous timeline observation as its caller sees it: pull-driven,
 * so a slow consumer accumulates no queue.
 *
 * The observation runs behind this wrapper because a bare async generator
 * cannot honour an end request while a pull is pending: `return()` would queue
 * behind a pull that an idle timeline never settles, and the observation would
 * hold its reader and its polling timer forever. The wrapper owns an internal
 * controller instead. `return` ends observation by aborting that controller,
 * which settles the pending poll and lets the loop release its reader in the
 * same turn, while a caller's own abort keeps its own failure.
 */
export function createAkumaStream(
  paths: AkumaPaths,
  id: AkuId,
  options: Readonly<{ signal?: AbortSignal }> = {},
  observe?: OutcomeObserver,
): AsyncIterableIterator<AkumaStreamSnapshot> {
  const caller = options.signal;
  const control = new AbortController();
  const observation = observeTimeline(paths, id, control.signal, observe);
  let wired = false;
  let unwire: (() => void) | undefined;
  let returning: Promise<IteratorResult<AkumaStreamSnapshot>> | undefined;
  const detach = (): void => {
    unwire?.();
    unwire = undefined;
  };
  const wire = (): void => {
    if (wired) return;
    wired = true;
    if (caller === undefined) return;
    const abort = (): void => control.abort(caller.reason);
    if (caller.aborted) {
      abort();
      return;
    }
    caller.addEventListener("abort", abort, { once: true });
    unwire = () => caller.removeEventListener("abort", abort);
  };
  const next = (): Promise<IteratorResult<AkumaStreamSnapshot>> => {
    wire();
    if (returning !== undefined) return Promise.resolve({ done: true, value: undefined });
    return observation.next().then(
      (result) => {
        if (result.done === true) detach();
        return result;
      },
      (error: unknown) => {
        detach();
        // An end request is completion, not the caller's failure to see.
        if (control.signal.reason === STREAM_RETURN) return { done: true, value: undefined };
        throw error;
      },
    );
  };
  const end = (value?: unknown): Promise<IteratorResult<AkumaStreamSnapshot>> => {
    wire();
    detach();
    if (returning === undefined) {
      control.abort(STREAM_RETURN);
      returning = observation.return(value).then((result) => ({ done: true, value: result.value }));
    }
    return returning;
  };
  const iterator: AsyncIterableIterator<AkumaStreamSnapshot> = {
    [Symbol.asyncIterator]: () => iterator,
    next,
    return: end,
  };
  return iterator;
}
