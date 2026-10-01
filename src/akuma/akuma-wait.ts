import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";
import { AkumaNotBornError } from "./akuma-errors.js";
import {
  defaultWaitComplete,
  readLiveStatus,
  readWaitComplete,
  waitForObservation,
  type LiveStatusObservation,
  type WaitReason,
} from "./akuma-observe.js";
import type { AkumaStatus } from "./akuma.js";
import type { DispatchAssociation } from "./dispatch-association.js";
import type { ActivityRow } from "./projection.js";
import type { AkumaUnobserved } from "./selection-observation.js";

export type WaitIdentityFacts = Readonly<{
  /** The alias currently addressing this Akuma in its world, when one is bound to it. */
  alias?: AkumaAlias;
  /** This Akuma's Dispatch association, read from the observing repository. */
  contract: DispatchAssociation;
}>;

/** One observed Akuma as a live wait viewer sees it: its status plus its identity facts. */
export type WaitObservedAkuma = Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }> & WaitIdentityFacts;

/** One selected Akuma's frozen identity, resolved before the first observation round. */
export type WaitSelectedAkuma = Readonly<{ id: AkumaStatus["id"] }> & WaitIdentityFacts;

/** A live wait viewer: the frozen selected set, then every observation round. */
export type WaitObserver = Readonly<{
  selected?: (selected: readonly WaitSelectedAkuma[]) => void;
  observe?: (observed: readonly WaitObservedAkuma[]) => void;
}>;

type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Internal custom completion judge over the full final observation where supplied. */
  predicate?: (status: AkumaStatus) => boolean;
  /** Resolves one Akuma's identity facts; consulted once per Akuma a viewer first sees. */
  identity?: (id: AkumaStatus["id"]) => Promise<WaitIdentityFacts>;
  /** The selected set in the caller's order; a viewer's head and scoreboard follow it. */
  selectionOrder?: readonly AkumaStatus["id"][];
  /** Reports the frozen selected set before the first round, so a viewer can fix its layout. */
  onSelected?: (selected: readonly WaitSelectedAkuma[]) => void;
  /** Reports every observation round to a live viewer. */
  observe?: (observed: readonly WaitObservedAkuma[]) => void;
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
  path: WorldRoot,
  ids: readonly AkumaStatus["id"][],
  signal?: AbortSignal,
): Promise<WaitRound> {
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    const observations = await Promise.all(
      ids.map(async (id) => await readLiveStatus(path, id, { aperture: "monitoring" })),
    );
    return { observations, unobserved: [] };
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const observations: LiveStatusObservation[] = [];
  const unobserved: AkumaUnobserved[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      const observed = await readLiveStatus(path, id, { aperture: "monitoring", ordinaryBudget: remaining });
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

/** Canonical ids in the caller's selection order, appending any id the caller never named. */
function selectionOrderedIds(
  ids: readonly AkumaStatus["id"][],
  order: readonly AkumaStatus["id"][],
): readonly AkumaStatus["id"][] {
  const present = new Set(ids);
  const seen = new Set<AkumaStatus["id"]>();
  const ordered: AkumaStatus["id"][] = [];
  for (const id of order) {
    if (present.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * The one lower set-observation owner for Akuma wait completion. It serves the
 * standalone one-ID association-free face and the plural any/all face with one
 * ordered round algorithm, one shared ordinary-detail budget, transient
 * unreadable peers, and an honest final deadline edge. The default completion
 * probe is used only without live row callbacks and never with a custom
 * predicate; a live viewer always observes rounds.
 */
export async function executeWaitAkuma(input: WaitExecutionInput): Promise<NativeWaitResult> {
  // Identity facts are read once per observed Akuma, not once per 100ms round.
  const facts = new Map<AkumaStatus["id"], WaitIdentityFacts>();
  if (input.onSelected !== undefined) {
    for (const id of input.ids) {
      input.signal?.throwIfAborted();
      const known = input.identity === undefined ? undefined : await input.identity(id);
      facts.set(id, known ?? { contract: { kind: "none" } });
    }
    const ordered =
      input.selectionOrder === undefined ? input.ids : selectionOrderedIds(input.ids, input.selectionOrder);
    input.onSelected(ordered.map((id) => ({ id, ...facts.get(id)! })));
  }
  const observeRound = async (round: WaitRound): Promise<void> => {
    if (input.observe === undefined) return;
    const observed: WaitObservedAkuma[] = [];
    for (const observation of round.observations) {
      input.signal?.throwIfAborted();
      const { status, rows } = observation;
      let known = facts.get(status.id);
      if (known === undefined && input.identity !== undefined) {
        known = await input.identity(status.id);
        facts.set(status.id, known);
      }
      if (known === undefined) {
        observed.push({ status, rows, contract: { kind: "none" } });
        continue;
      }
      observed.push({ status, rows, ...known });
    }
    input.observe(observed);
  };
  const live = input.observe !== undefined;
  const waited = await waitForObservation({
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.predicate === undefined && !live && input.ids.length === 1
      ? { probe: async () => await readWaitComplete(input.path, input.ids[0]!) }
      : {}),
    observe: async () => await observeWaitRound(input.path, input.ids, input.signal),
    complete: (round) => roundComplete(round, input.completion, input.predicate),
    onObserve: async (round) => await observeRound(round),
  });
  return {
    mode: input.completion,
    reason: waited.reason,
    observations: waited.value.observations.map((observation) => observation.status),
    unobserved: waited.value.unobserved,
  };
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
