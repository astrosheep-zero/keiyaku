import { observeContractWorld, observeDeliveryTargetAt } from "../../git/observe.js";
import { deliveryWorktreePath } from "../../git/workspace.js";
import type { GitRepository } from "../../git/repository.js";
import { withGitReadObservation, type GitDecodeChannel, type GitReadObservation } from "../../git/read-observation.js";
import { gateReports, type GateCurrent } from "../../core/facts/gate.js";
import type { ContractId, ContractState, DeliverData, SnapshotId } from "../../core/facts/types.js";

export type ContractPhase = "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned";
export type ContractDisposition = "active" | "terminal";

export type ContractGateCurrent = GateCurrent;

export type ContractGateReport = Readonly<{ gate: string; current: ContractGateCurrent }>;

export type ContractRow = Readonly<{
  id: ContractId;
  phase: ContractPhase;
  disposition: ContractDisposition;
  workspace: "worktree" | "here";
  worktreePath: string | null;
  target: string | null;
  delivery: DeliverData | null;
  targetObservation: Readonly<{ head: SnapshotId | null; drift: boolean }> | null;
  gates: Readonly<{
    reports: readonly ContractGateReport[];
    satisfied: boolean;
  }>;
}>;

export type ContractBoard = Readonly<{
  root: string;
  state: SnapshotId | null;
  rows: readonly ContractRow[];
}>;

export type ContractObservation =
  | Readonly<{ kind: "missing"; id: ContractId }>
  | Readonly<{ kind: "present"; row: ContractRow }>;

function phaseFor(state: ContractState): ContractPhase {
  if (state.terminal?.kind === "claimed") return "claimed";
  if (state.terminal?.kind === "abandoned") return "abandoned";
  if (state.delivery !== null) return "pending-delivery";
  if (state.bound !== null) return "bound";
  return "waiting";
}

function rowFor(
  repository: GitRepository,
  state: ContractState,
  targetObservation: ContractRow["targetObservation"],
): ContractRow {
  const workspace = state.coordinates.workspace;
  const gates = gateReports(state);
  return {
    id: state.id,
    phase: phaseFor(state),
    disposition: state.terminal === null ? "active" : "terminal",
    workspace,
    worktreePath: workspace === "worktree" ? deliveryWorktreePath(repository, state.id) : null,
    target: state.coordinates.target ?? null,
    delivery: state.delivery?.data ?? null,
    targetObservation,
    gates: {
      reports: gates.reports.map((report) => ({ gate: report.gate, current: report.current })),
      satisfied: gates.satisfied,
    },
  };
}

/** Build the Contract board from one immutable git observation. */
export async function readContractBoard(observation: GitReadObservation): Promise<ContractBoard> {
  const observed = await observeContractWorld(observation);
  const rows: Promise<ContractRow>[] = [];
  for (const value of observed.contracts.values()) {
    if (value.state === null) continue;
    const state = value.state;
    rows.push(observeDeliveryTargetAt(observation, state).then((target) =>
      rowFor(observation.repository, state, target)));
  }
  return { root: observation.repository.primaryWorktree, state: observed.snapshot, rows: await Promise.all(rows) };
}

/** Observe one Contract and its target from one fresh ref epoch. */
export async function readContractObservationAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
): Promise<ContractObservation> {
  return withGitReadObservation(repository, channel, async (observation) => {
    const world = await observeContractWorld(observation, [id]);
    const state = world.contracts.get(id)?.state ?? null;
    return state === null
      ? { kind: "missing", id }
      : { kind: "present", row: rowFor(observation.repository, state, await observeDeliveryTargetAt(observation, state)) };
  });
}
