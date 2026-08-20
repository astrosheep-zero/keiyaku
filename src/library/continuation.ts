import type { ContractId, ContractState, JournalEntry } from "../core/facts/types.js";
import { observeActiveContractWorld } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { continueDeliveryOperation } from "../protocol/deliver.js";
import type {
  DocumentDerivation,
  HereWorkspaceResolver,
  PlacementStop,
  RepositoryScope,
} from "../protocol/operations.js";
import type { AcceptedIntent } from "./mutation.js";

export type ContinuationReport = Readonly<{
  claimed: readonly ContractId[];
  stopped: readonly Readonly<{
    contractId: ContractId;
    stop: PlacementStop | Readonly<{ kind: "already-terminal" }>;
  }>[];
}>;

type RetainedDependent = Readonly<{
  state: ContractState;
  journal: readonly JournalEntry[];
}>;

function reverseDependents(
  world: Awaited<ReturnType<typeof observeActiveContractWorld>>,
): ReadonlyMap<ContractId, readonly RetainedDependent[]> {
  const index = new Map<ContractId, RetainedDependent[]>();
  for (const record of world.contracts.values()) {
    const state = record.state;
    if (state === null || state.delivery === null) continue;
    const dependent = { state, journal: record.entries };
    for (const prerequisite of state.terms.after) {
      const dependents = index.get(prerequisite) ?? [];
      dependents.push(dependent);
      index.set(prerequisite, dependents);
    }
  }
  for (const dependents of index.values()) dependents.sort((left, right) => left.state.id.localeCompare(right.state.id));
  return index;
}

function appendAccepted<Value>(
  primary: AcceptedIntent<Value>,
  child: Readonly<Pick<AcceptedIntent<unknown>, "facts" | "physical">>,
): AcceptedIntent<Value> {
  const effects = [...(primary.physical?.effects ?? []), ...(child.physical?.effects ?? [])];
  const lag = [...(primary.physical?.lag ?? []), ...(child.physical?.lag ?? [])];
  return {
    ...primary,
    facts: [...primary.facts, ...child.facts],
    ...(effects.length === 0 && lag.length === 0 ? {} : { physical: { effects, lag } }),
  };
}

export async function continueDeliveredDependents<Value extends object>(input: Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  deriveDocument: (state: ContractState) => DocumentDerivation;
  resolveHereWorkspace?: HereWorkspaceResolver;
  actor?: import("../core/facts/types.js").ActorId;
  signal?: AbortSignal;
}>): Promise<AcceptedIntent<Value & Readonly<{ continuation?: ContinuationReport }>>> {
  const world = await withGitReadObservation(
    input.scope,
    input.channel,
    async (observation) => await observeActiveContractWorld(observation),
  );
  const dependents = reverseDependents(world);
  const pending = [input.contractId];
  const attempted = new Set<ContractId>();
  const newlyClaimed = new Set<ContractId>(pending);
  const claimed: ContractId[] = [];
  const stopped: ContinuationReport["stopped"][number][] = [];
  let accepted = input.accepted;

  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const candidate of dependents.get(parent) ?? []) {
      const contractId = candidate.state.id;
      if (
        attempted.has(contractId)
        || !candidate.state.terms.after.every((dependency) =>
          newlyClaimed.has(dependency) || world.eligibility.get(dependency)?.terminal?.kind === "claimed")
      ) continue;
      attempted.add(contractId);
      const child = await continueDeliveryOperation({
        scope: input.scope,
        channel: input.channel,
        state: candidate.state,
        journal: candidate.journal,
        deriveDocument: input.deriveDocument,
        ...(input.resolveHereWorkspace === undefined ? {} : { resolveHereWorkspace: input.resolveHereWorkspace }),
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      accepted = appendAccepted(accepted, child.admission);
      if (child.evidence.completion !== undefined) {
        claimed.push(contractId);
        newlyClaimed.add(contractId);
        pending.push(contractId);
        continue;
      }
      const stop = child.evidence.placement;
      if (stop === undefined) throw new Error("incomplete continuation is missing its placement stop");
      if ("refusal" in stop && stop.refusal.kind === "terminal") {
        stopped.push({ contractId, stop: { kind: "already-terminal" } });
      } else {
        stopped.push({ contractId, stop });
      }
    }
  }

  return {
    ...accepted,
    value: {
      ...accepted.value,
      ...(attempted.size === 0 ? {} : { continuation: { claimed, stopped } }),
    },
  };
}
