import type { ContractId, ContractState, JournalEntry } from "../core/facts/types.js";
import { observeActiveContractWorld } from "../git/observe.js";
import { withGitReadObservation, type GitDecodeChannel } from "../git/read-observation.js";
import { reconcileDependentWorktree } from "../git/reconcile.js";
import type { ReconcileResult } from "../git/reconcile.js";
import { worktreePath } from "../git/workspace.js";
import { continueDeliveryOperation } from "../protocol/deliver.js";
import type { DocumentDerivation, PlacementStop, RepositoryScope } from "../protocol/operations.js";
import type { AcceptedIntent } from "./mutation.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";

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
  for (const dependents of index.values())
    dependents.sort((left, right) => left.state.id.localeCompare(right.state.id));
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

function appendPhysical<Value>(primary: AcceptedIntent<Value>, physical: ReconcileResult): AcceptedIntent<Value> {
  const effects = [...(primary.physical?.effects ?? []), ...physical.effects];
  const lag = [...(primary.physical?.lag ?? []), ...physical.lag];
  return {
    ...primary,
    ...(effects.length === 0 && lag.length === 0 ? {} : { physical: { effects, lag } }),
  };
}

// The bounded dependency walk keeps selection, physical follow, and child admission together.
// eslint-disable-next-line max-lines-per-function
export async function continueDeliveredDependents<Value extends object>(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    contractId: ContractId;
    accepted: AcceptedIntent<Value>;
    deriveDocument: (state: ContractState) => DocumentDerivation;
    actor?: import("../core/facts/types.js").ActorId;
    signal?: AbortSignal;
  }>,
): Promise<AcceptedIntent<Value & Readonly<{ continuation?: ContinuationReport }>>> {
  const world = await withGitReadObservation(
    input.scope,
    input.channel,
    async (observation) => await observeActiveContractWorld(observation),
  );
  const dependents = reverseDependents(world);
  const places = await readPlaceRegister(input.scope);
  const initialTarget =
    typeof input.accepted.value === "object" && input.accepted.value !== null && "completion" in input.accepted.value
      ? ((input.accepted.value as { completion?: { integration?: import("../core/facts/types.js").SnapshotId } })
          .completion?.integration ?? undefined)
      : undefined;
  const pending = [{ contractId: input.contractId, target: initialTarget }];
  const attempted = new Set<ContractId>();
  const newlyClaimed = new Set<ContractId>([input.contractId]);
  const claimed: ContractId[] = [];
  const stopped: ContinuationReport["stopped"][number][] = [];
  let accepted = input.accepted;

  const process = async (
    candidate: RetainedDependent,
    predecessorTarget: import("../core/facts/types.js").SnapshotId | undefined,
  ): Promise<
    Readonly<{
      accepted: AcceptedIntent<Value>;
      outcome: "claimed" | "stopped" | "skip";
      stop?: ContinuationReport["stopped"][number]["stop"];
    }>
  > => {
    const contractId = candidate.state.id;
    if (
      !candidate.state.terms.after.every(
        (dependency) => newlyClaimed.has(dependency) || world.eligibility.get(dependency)?.terminal?.kind === "claimed",
      )
    ) {
      return { accepted, outcome: "skip" };
    }
    attempted.add(contractId);
    if (predecessorTarget !== undefined && candidate.state.coordinates.workspace === "worktree") {
      const appointment = appointmentFor(places, contractId);
      if (appointment !== undefined) {
        const reconciled = await reconcileDependentWorktree(
          input.scope,
          contractId,
          worktreePath(input.scope, appointment.place),
          predecessorTarget,
        );
        accepted = appendPhysical(accepted, reconciled);
        if (reconciled.lag.length > 0) return { accepted, outcome: "stopped" };
      }
    }
    const child = await continueDeliveryOperation({
      scope: input.scope,
      channel: input.channel,
      state: candidate.state,
      journal: candidate.journal,
      deriveDocument: input.deriveDocument,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    accepted = appendAccepted(accepted, child.admission);
    if (child.evidence.completion !== undefined) {
      newlyClaimed.add(contractId);
      pending.push({ contractId, target: child.evidence.completion.integration });
      return { accepted, outcome: "claimed" };
    }
    const stop = child.evidence.placement;
    if (stop === undefined) throw new Error("incomplete continuation is missing its placement stop");
    return {
      accepted,
      outcome: "stopped",
      stop: "refusal" in stop && stop.refusal.kind === "terminal" ? { kind: "already-terminal" } : stop,
    };
  };

  while (pending.length > 0) {
    const parent = pending.shift()!;
    for (const candidate of dependents.get(parent.contractId) ?? []) {
      const contractId = candidate.state.id;
      if (attempted.has(contractId)) continue;
      const result = await process(candidate, parent.target);
      accepted = result.accepted;
      if (result.outcome === "claimed") claimed.push(contractId);
      if (result.outcome === "stopped" && result.stop !== undefined) stopped.push({ contractId, stop: result.stop });
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

export async function continueAcceptedCompletion<Value extends Readonly<{ completion?: unknown }>>(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    contractId: ContractId;
    accepted: AcceptedIntent<Value>;
    deriveDocument: (state: ContractState) => DocumentDerivation;
    actor?: import("../core/facts/types.js").ActorId;
    signal?: AbortSignal;
  }>,
): Promise<AcceptedIntent<Value & Readonly<{ continuation?: ContinuationReport }>>> {
  if (input.accepted.value.completion === undefined) return input.accepted;
  return await continueDeliveredDependents(input);
}
