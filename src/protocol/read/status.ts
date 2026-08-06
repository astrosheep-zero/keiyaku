import { observeCarrier } from "../../carrier/observe.js";
import { deliveryWorktreePath } from "../../carrier/reconcile.js";
import type { GitRepository } from "../../carrier/repository.js";
import type { ContractId, ContractState } from "../../core/facts/types.js";

export type ContractStatus = Readonly<{
  contractId: ContractId;
  phase: "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned";
  terminal: "claimed" | "abandoned" | null;
  workspace: "worktree" | "here" | null;
  worktreePath: string | null;
  target: string | null;
}>;

export type StatusReport = Readonly<{
  scope: string;
  contracts: readonly ContractStatus[];
}>;

function phaseFor(state: ContractState): ContractStatus["phase"] {
  if (state.terminal?.kind === "claimed") return "claimed";
  if (state.terminal?.kind === "abandoned") return "abandoned";
  if (state.delivery !== null) return "pending-delivery";
  if (state.bound !== null) return "bound";
  return "waiting";
}

function statusFor(repository: GitRepository, state: ContractState): ContractStatus {
  const workspace = state.coordinates?.workspace ?? null;
  return {
    contractId: state.id,
    phase: phaseFor(state),
    terminal: state.terminal?.kind ?? null,
    workspace,
    worktreePath: workspace === "worktree" ? deliveryWorktreePath(repository, state.id) : null,
    target: state.coordinates?.target ?? null,
  };
}

/** Build a status board from one immutable carrier observation. */
export function readStatus(repository: GitRepository, contract?: ContractId): StatusReport {
  const observed = observeCarrier(repository, contract ? [contract] : []);
  const contracts: ContractStatus[] = [];
  for (const value of observed.contracts.values()) {
    if (value.state === null || (contract !== undefined && value.id !== contract)) continue;
    contracts.push(statusFor(repository, value.state));
  }
  return { scope: repository.effectiveCwd, contracts };
}
