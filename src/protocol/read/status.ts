import {
  observeActiveContractWorld,
  observeContractsForAdmissionInObservationAt,
  observeDeliveryTargetAt,
  withContractReadObservationAt,
} from "../../git/observe.js";
import { decodeContractDocument } from "../../body/decode.js";
import {
  deliveryWorktreePath,
  observeTargetLag,
  observeWorkspace,
} from "../../git/workspace.js";
import type { ContractTargetLag, ContractWorkspaceObservation } from "../../git/workspace.js";
import type { GitRepository } from "../../git/repository.js";
import type { GitDecodeChannel, GitReadObservation } from "../../git/read-observation.js";
import { gateReports, type GateCurrent } from "../../core/facts/gate.js";
import type { ContractId, ContractState, DeliverData, SnapshotId } from "../../core/facts/types.js";

export type ContractPhase = "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned";
export type ContractDisposition = "active" | "terminal";

export type ContractGateCurrent = GateCurrent;

export type ContractGateReport = Readonly<{ gate: string; current: ContractGateCurrent }>;

export type { ContractTargetLag, ContractWorkspaceObservation };

export type ContractRow = Readonly<{
  id: ContractId;
  title: string | null;
  phase: ContractPhase;
  disposition: ContractDisposition;
  workspace: "worktree" | "here";
  worktreePath: string | null;
  workspaceObservation: ContractWorkspaceObservation;
  target: string | null;
  targetLag: ContractTargetLag;
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

function titleFor(state: ContractState): string | null {
  try {
    return decodeContractDocument(state.terms.document.bytes).title;
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function phaseFor(state: ContractState): ContractPhase {
  if (state.terminal?.kind === "claimed") return "claimed";
  if (state.terminal?.kind === "abandoned") return "abandoned";
  if (state.delivery !== null) return "pending-delivery";
  if (state.bound !== null) return "bound";
  return "waiting";
}

async function rowFor(
  repository: GitRepository,
  state: ContractState,
  targetObservation: ContractRow["targetObservation"],
): Promise<ContractRow> {
  const workspace = state.coordinates.workspace;
  const gates = gateReports(state);
  const location = workspace === "worktree"
    ? { kind: "worktree" as const, path: deliveryWorktreePath(repository, state.id) }
    : { kind: "here" as const };
  const workspacePath = location.kind === "worktree" ? location.path : repository.effectiveCwd;
  const [workspaceObservation, targetLag] = await Promise.all([
    observeWorkspace(repository, location, workspacePath),
    observeTargetLag(repository, workspacePath, targetObservation?.head),
  ]);
  return {
    id: state.id,
    title: titleFor(state),
    phase: phaseFor(state),
    disposition: state.terminal === null ? "active" : "terminal",
    workspace,
    worktreePath: location.kind === "worktree" ? location.path : null,
    workspaceObservation,
    target: state.coordinates.target ?? null,
    targetLag,
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
  const observed = await observeActiveContractWorld(observation);
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
  return withContractReadObservationAt(repository, channel, id, async (observation) => {
    const observed = await observeContractsForAdmissionInObservationAt(observation, [id]);
    const state = observed.decision.get(id) ?? null;
    return state === null
      ? { kind: "missing", id }
      : {
          kind: "present",
          row: await rowFor(
            observation.repository,
            state,
            await observeDeliveryTargetAt(observation, state),
          ),
        };
  });
}
