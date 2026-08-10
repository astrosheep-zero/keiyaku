import { observeGit, observeContract } from "../../git/observe.js";
import { deliveryWorktreePath } from "../../git/reconcile.js";
import type { GitRepository } from "../../git/repository.js";
import { gateReports, type GateCurrent } from "../../core/facts/gate.js";
import type { ContractId, ContractState, SnapshotId } from "../../core/facts/types.js";

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
  candidate: SnapshotId | null;
  gates: Readonly<{
    reports: readonly ContractGateReport[];
    satisfied: boolean;
  }>;
}>;

export type ContractBoard = Readonly<{
  root: string;
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

function rowFor(repository: GitRepository, state: ContractState): ContractRow {
  const workspace = state.coordinates.workspace;
  const gates = gateReports(state);
  return {
    id: state.id,
    phase: phaseFor(state),
    disposition: state.terminal === null ? "active" : "terminal",
    workspace,
    worktreePath: workspace === "worktree" ? deliveryWorktreePath(repository, state.id) : null,
    target: state.coordinates.target ?? null,
    candidate: state.delivery?.data.candidate ?? null,
    gates: {
      reports: gates.reports.map((report) => ({ gate: report.gate, current: report.current })),
      satisfied: gates.satisfied,
    },
  };
}

/** Build the Contract board from one immutable git observation. */
export function readContractBoard(repository: GitRepository): ContractBoard {
  const observed = observeGit(repository);
  const rows: ContractRow[] = [];
  for (const value of observed.contracts.values()) {
    if (value.state === null) continue;
    rows.push(rowFor(repository, value.state));
  }
  return { root: repository.primaryWorktree, rows };
}

/** Observe one Contract without enumerating the Contract world. */
export function readContractObservation(repository: GitRepository, id: ContractId): ContractObservation {
  const state = observeContract(repository, id).state;
  return state === null ? { kind: "missing", id } : { kind: "present", row: rowFor(repository, state) };
}
