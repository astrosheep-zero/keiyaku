import { AkumaNotBornError, defaultWaitComplete, type AkumaStatus } from "./akuma.js";
import { createAkumaProduct } from "./akuma-product.js";
import { readBudgetedStatus, readLiveStatus, waitForObservation, type LiveStatusObservation } from "./akuma-observe.js";
import type { ActivityRow } from "./projection.js";
import { NO_DISPATCH_ASSOCIATION, type DispatchAssociation } from "./dispatch-association.js";
import { EMPTY_CREATED_TASK_OBSERVATION } from "../task/created-observation.js";
import type { AkumaAlias } from "../identity/selector.js";
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

type WaitRound = Readonly<{
  statuses: readonly AkumaStatus[];
  live: readonly LiveStatusObservation[];
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
  live: boolean,
  signal?: AbortSignal,
): Promise<WaitRound> {
  signal?.throwIfAborted();
  if (ids.length <= 1) {
    if (live) {
      const observations = await Promise.all(
        ids.map(async (id) => await readLiveStatus(path, id, { aperture: "monitoring" })),
      );
      return { statuses: observations.map((observation) => observation.status), live: observations, unobserved: [] };
    }
    return {
      statuses: await Promise.all(ids.map(async (id) => await source(path).selectHandle({ id }).status())),
      live: [],
      unobserved: [],
    };
  }
  let remaining = SHARED_ORDINARY_BUDGET;
  const statuses: AkumaStatus[] = [];
  const observations: LiveStatusObservation[] = [];
  const unobserved: AkumaUnobserved[] = [];
  for (const id of ids) {
    signal?.throwIfAborted();
    try {
      if (live) {
        const observed = await readLiveStatus(path, id, { aperture: "monitoring", ordinaryBudget: remaining });
        statuses.push(observed.status);
        observations.push(observed);
        remaining -= observed.ordinarySelected;
        continue;
      }
      const observed = await readBudgetedStatus(path, id, { aperture: "monitoring", ordinaryBudget: remaining });
      statuses.push(observed.status);
      remaining -= observed.ordinarySelected;
    } catch (error) {
      if (error instanceof AkumaNotBornError) throw error;
      unobserved.push({ id, diagnostic: observationDiagnostic(error) });
    }
  }
  return { statuses, live: observations, unobserved };
}

function roundComplete(round: WaitRound, completion: "any" | "all"): boolean {
  const settled = round.statuses.map(defaultWaitComplete);
  return (
    settled.length > 0 &&
    (completion === "any" ? settled.some(Boolean) : round.unobserved.length === 0 && settled.every(Boolean))
  );
}

export type WaitIdentityFacts = Readonly<{
  /** The alias currently addressing this Akuma in its world, when one is bound to it. */
  alias?: AkumaAlias;
  /** This Akuma's Dispatch association, read from the observing repository. */
  contract: DispatchAssociation;
}>;

/** One observed Akuma as a live wait viewer sees it: its status plus its identity facts. */
export type WaitObservedAkuma = Readonly<{ status: AkumaStatus; rows?: readonly ActivityRow[] }> & WaitIdentityFacts;

/** One selected Akuma's frozen identity, resolved before the first observation round. */
export type WaitSelectedAkuma = Readonly<{ id: AkumaStatus["id"] }> & WaitIdentityFacts;

/** A live wait viewer: the frozen selected set, then every observation round. */
export type WaitObserver = Readonly<{
  selected?: (selected: readonly WaitSelectedAkuma[]) => void;
  observe?: (observed: readonly WaitObservedAkuma[]) => void;
}>;

export type WaitExecutionInput = Readonly<{
  path: WorldRoot;
  ids: readonly AkumaStatus["id"][];
  completion: "any" | "all";
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Resolves one Akuma's identity facts; consulted once per Akuma a viewer first sees. */
  identity?: (id: AkumaStatus["id"]) => Promise<WaitIdentityFacts>;
  /** The selected set in the caller's order; a viewer's head and scoreboard follow it. */
  selectionOrder?: readonly AkumaStatus["id"][];
  /** Reports the frozen selected set before the first round, so a viewer can fix its layout. */
  onSelected?: (selected: readonly WaitSelectedAkuma[]) => void;
  /** Reports every observation round to a live viewer; absent keeps the cheap completion probe. */
  observe?: (observed: readonly WaitObservedAkuma[]) => void;
}>;

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

export async function executeWaitAkuma(input: WaitExecutionInput): Promise<AkumaWaitResult> {
  // Identity facts are read once per observed Akuma, not once per 100ms round.
  const facts = new Map<AkumaStatus["id"], WaitIdentityFacts>();
  if (input.onSelected !== undefined) {
    for (const id of input.ids) {
      input.signal?.throwIfAborted();
      const known = input.identity === undefined ? undefined : await input.identity(id);
      facts.set(id, known ?? { contract: NO_DISPATCH_ASSOCIATION });
    }
    const ordered =
      input.selectionOrder === undefined ? input.ids : selectionOrderedIds(input.ids, input.selectionOrder);
    input.onSelected(ordered.map((id) => ({ id, ...facts.get(id)! })));
  }
  const observeRound = async (round: WaitRound): Promise<void> => {
    if (input.observe === undefined) return;
    const observed: WaitObservedAkuma[] = [];
    const liveById = new Map(round.live.map((observation) => [observation.status.id, observation.rows]));
    for (const status of round.statuses) {
      input.signal?.throwIfAborted();
      let known = facts.get(status.id);
      if (known === undefined && input.identity !== undefined) {
        known = await input.identity(status.id);
        facts.set(status.id, known);
      }
      if (known === undefined) {
        observed.push({
          status,
          ...(liveById.has(status.id) ? { rows: liveById.get(status.id)! } : {}),
          contract: NO_DISPATCH_ASSOCIATION,
        });
        continue;
      }
      observed.push({ status, ...(liveById.has(status.id) ? { rows: liveById.get(status.id)! } : {}), ...known });
    }
    input.observe(observed);
  };
  const waited = await waitForObservation({
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    observe: async () => await observeWaitRound(input.path, input.ids, input.observe !== undefined, input.signal),
    complete: (round) => roundComplete(round, input.completion),
    onObserve: async (round) => await observeRound(round),
  });
  return fleetResultSchemas.wait.parse({
    mode: input.completion,
    reason: waited.reason,
    observations: waited.value.statuses.map(akumaOnlyObservation),
    unobserved: waited.value.unobserved,
  });
}

export type TellExecutionInput = Readonly<{
  path: WorldRoot;
  id: AkumaStatus["id"];
  body: string;
  tellId?: string;
  recordedAt?: string;
  initiator?: string;
  signal?: AbortSignal;
}>;

export async function executeTellAkuma(input: TellExecutionInput): Promise<AkumaTellResult> {
  input.signal?.throwIfAborted();
  const handle = source(input.path).selectHandle({ id: input.id });
  const tell = await handle.tell(input.body, input.tellId, input.recordedAt, undefined, {
    ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
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
  const handles = input.ids.map((id) => source(input.path).selectHandle({ id }));
  const evidence = await Promise.all(
    handles.map(async (handle) => await handle.kill(input.signal === undefined ? {} : { signal: input.signal })),
  );
  input.signal?.throwIfAborted();
  return fleetResultSchemas.kill.parse({
    results: input.ids.map((id, index) => ({ id, evidence: evidence[index]! })),
  });
}
