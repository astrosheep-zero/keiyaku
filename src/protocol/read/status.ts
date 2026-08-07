import { observeCarrier, observeContract } from "../../carrier/observe.js";
import { deliveryWorktreePath } from "../../carrier/reconcile.js";
import type { GitRepository } from "../../carrier/repository.js";
import { latestCurrentAttestations } from "../../core/facts/gate.js";
import { gate, type ContractId, type ContractState, type Gate } from "../../core/facts/types.js";

const VERIFIED = gate("verified");
const VERIFIED_GATE: ReadonlySet<Gate> = new Set([VERIFIED]);

export type ContractStatus = Readonly<{
  contractId: ContractId;
  phase: "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned";
  workspace: "worktree" | "here";
  worktreePath: string | null;
  target: string | null;
  verification: Readonly<{
    verdict: "satisfied" | "unsatisfied";
    summary?: string;
  }> | null;
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
  const workspace = state.coordinates.workspace;
  const verification = latestCurrentAttestations(state, VERIFIED_GATE).get(VERIFIED);
  return {
    contractId: state.id,
    phase: phaseFor(state),
    workspace,
    worktreePath: workspace === "worktree" ? deliveryWorktreePath(repository, state.id) : null,
    target: state.coordinates.target ?? null,
    verification: verification === undefined ? null : {
      verdict: verification.data.verdict,
      ...(verification.data.summary === undefined ? {} : { summary: verification.data.summary }),
    },
  };
}

/** Build a status board from one immutable carrier observation. */
export function readStatus(repository: GitRepository, contract?: ContractId): StatusReport {
  if (contract !== undefined) {
    const state = observeContract(repository, contract).state;
    return {
      scope: repository.effectiveCwd,
      contracts: state === null ? [] : [statusFor(repository, state)],
    };
  }
  const observed = observeCarrier(repository);
  const contracts: ContractStatus[] = [];
  for (const value of observed.contracts.values()) {
    if (value.state === null) continue;
    contracts.push(statusFor(repository, value.state));
  }
  return { scope: repository.effectiveCwd, contracts };
}
