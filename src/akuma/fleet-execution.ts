import { AkumaDecodeError, AkumaProviderError } from "./akuma-errors.js";
import { AkumaNotBornError, defaultWaitComplete, type AkumaStatus, type TellResult } from "./akuma.js";
import { createAkumaProduct } from "./akuma-product.js";
import { readLiveStatus, waitForObservation, type LiveStatusObservation } from "./akuma-observe.js";
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
  type AkumaTellWaitResult,
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
  observations: readonly LiveStatusObservation[];
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
      unobserved.push({ id, diagnostic: observationDiagnostic(error) });
    }
  }
  return { observations, unobserved };
}

function roundComplete(round: WaitRound, completion: "any" | "all"): boolean {
  const settled = round.observations.map((observation) => defaultWaitComplete(observation.status));
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
export type WaitObservedAkuma = Readonly<{ status: AkumaStatus; rows: readonly ActivityRow[] }> & WaitIdentityFacts;

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
  /** Reports every observation round to a live viewer. */
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
    for (const observation of round.observations) {
      input.signal?.throwIfAborted();
      const { status, rows } = observation;
      let known = facts.get(status.id);
      if (known === undefined && input.identity !== undefined) {
        known = await input.identity(status.id);
        facts.set(status.id, known);
      }
      if (known === undefined) {
        observed.push({ status, rows, contract: NO_DISPATCH_ASSOCIATION });
        continue;
      }
      observed.push({ status, rows, ...known });
    }
    input.observe(observed);
  };
  const waited = await waitForObservation({
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    observe: async () => await observeWaitRound(input.path, input.ids, input.signal),
    complete: (round) => roundComplete(round, input.completion),
    onObserve: async (round) => await observeRound(round),
  });
  return fleetResultSchemas.wait.parse({
    mode: input.completion,
    reason: waited.reason,
    observations: waited.value.observations.map((observation) => akumaOnlyObservation(observation.status)),
    unobserved: waited.value.unobserved,
  });
}

export type TellWaitObserver = Readonly<{
  admitted?: (tell: TellResult, id: AkumaStatus["id"]) => void | Promise<void>;
  observe?: (observation: LiveStatusObservation) => void | Promise<void>;
}>;

export type TellExecutionInput = Readonly<{
  path: WorldRoot;
  id: AkumaStatus["id"];
  body: string;
  tellId?: string;
  recordedAt?: string;
  initiator?: string;
  signal?: AbortSignal;
  onObserve?: TellWaitObserver;
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

export async function executeTellWaitAkuma(
  input: TellExecutionInput & Readonly<{ timeoutMs: number; schemaJson?: string; interrupt?: boolean }>,
): Promise<AkumaTellWaitResult> {
  input.signal?.throwIfAborted();
  const handle = source(input.path).selectHandle({ id: input.id });
  const admission =
    input.interrupt === true
      ? await handle.admitInterrupt(input.body, {
          ...(input.tellId === undefined ? {} : { tellId: input.tellId }),
          ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
          ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        })
      : await handle.admitTell(input.body, input.tellId, input.recordedAt, undefined, {
          ...(input.schemaJson === undefined ? {} : { schemaJson: input.schemaJson }),
          ...(input.initiator === undefined ? {} : { initiator: input.initiator }),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
  if (admission.kind === "unavailable")
    throw new AkumaProviderError(`Tell interrupt unavailable: ${admission.evidence}`);
  if (admission.kind === "not-born") throw new AkumaNotBornError(input.id);
  await input.onObserve?.admitted?.(await handle.admittedReceipt(admission.tell.id), input.id);
  // The wake runs behind the window; a settled wake is preferred, otherwise the
  // receipt reports the admitted Tell as it stands when the window closes.
  let settled: TellResult | undefined;
  void admission.wake.then(
    (receipt) => {
      settled = receipt;
    },
    () => undefined,
  );
  const observed = await handle.tellOutcome(admission.tell.id, {
    timeoutMs: input.timeoutMs,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.onObserve?.observe === undefined ? {} : { observe: input.onObserve.observe }),
  });
  const observation =
    observed.outcome === null
      ? observed.reason === "deadline"
        ? { reason: "deadline" as const }
        : { reason: "unanswered" as const }
      : observed.outcome.kind === "answered"
        ? { reason: "answered" as const, answer: observed.outcome.answerJson ?? observed.outcome.answer }
        : observed.outcome.kind === "failed"
          ? { reason: "failed" as const, diagnostic: observed.outcome.diagnostic }
          : (() => {
              throw new AkumaDecodeError(observed.outcome.diagnostic, observed.outcome.answer);
            })();
  const tell = settled ?? (await handle.admittedReceipt(admission.tell.id));
  return fleetResultSchemas.tellWait.parse({ akuma: input.id, tell, observation });
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
