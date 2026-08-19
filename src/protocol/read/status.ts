import {
  observeActiveContractWorld,
  observeContractsForAdmissionInObservationAt,
  observeDeliveryTargetAt,
  withContractReadObservationAt,
} from "../../git/observe.js";
import { decodeContractDocument } from "../../body/decode.js";
import {
  observeTargetLag,
  observeWorkspace,
  worktreePath,
} from "../../git/workspace.js";
import {
  appointmentFor,
  readPlaceRegister,
  type PlaceRegister,
} from "../../workspace-place.js";
import type { ContractTargetLag, ContractWorkspaceObservation } from "../../git/workspace.js";
import type { GitRepository } from "../../git/process.js";
import type { GitDecodeChannel, GitReadObservation } from "../../git/read-observation.js";
import { gateReports, type GateCurrent } from "../../core/facts/gate.js";
import type { ContractId, ContractState, DeliverData, JournalEntry, SnapshotId } from "../../core/facts/types.js";

export type ContractPhase = "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned";
export type ContractDisposition = "active" | "terminal";

export type ContractGateCurrent = GateCurrent;

export type ContractGateReport = Readonly<{ gate: string; current: ContractGateCurrent }>;

export type { ContractTargetLag, ContractWorkspaceObservation };
export type HereWorkspaceObservationResolution =
  | Readonly<{ kind: "appointed"; path: string }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;
export type HereWorkspaceObservationResolver = (contractId: ContractId) => Promise<HereWorkspaceObservationResolution>;

export type ContractRow = Readonly<{
  id: ContractId;
  title: string | null;
  phase: ContractPhase;
  phaseAt: string;
  lastJournalAt: string;
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

export function phaseAtFor(
  state: Pick<ContractState, "terminal" | "delivery" | "bound">,
  bindAt: string,
): string {
  return state.terminal?.at ?? state.delivery?.at ?? state.bound?.at ?? bindAt;
}

export function lastJournalAtFor(entries: readonly Pick<JournalEntry, "at">[]): string {
  const last = entries.at(-1);
  if (last === undefined) throw new Error("present Contract journal is empty");
  return last.at;
}

async function managedWorkspaceFacts(
  repository: GitRepository,
  state: ContractState,
  register: PlaceRegister,
  targetObservation: ContractRow["targetObservation"],
): Promise<Readonly<{
  appointed: ReturnType<typeof appointmentFor>;
  workspaceObservation: ContractWorkspaceObservation;
  targetLag: ContractTargetLag;
}>> {
  const appointed = appointmentFor(register, state.id);
  if (appointed === undefined) {
    return {
      appointed,
      workspaceObservation: { kind: "unappointed" },
      targetLag: state.coordinates.target === undefined ? { kind: "none" } : { kind: "unknown" },
    };
  }
  const path = worktreePath(repository, appointed.place);
  const [workspaceObservation, targetLag] = await Promise.all([
    observeWorkspace(repository, { kind: "worktree", path }, path),
    observeTargetLag(repository, path, targetObservation?.head),
  ]);
  return { appointed, workspaceObservation, targetLag };
}

async function hereWorkspaceFacts(
  repository: GitRepository,
  contractId: ContractId,
  targetObservation: ContractRow["targetObservation"],
  resolveHereWorkspace?: HereWorkspaceObservationResolver,
): Promise<Readonly<{
  appointed: undefined;
  workspaceObservation: ContractWorkspaceObservation;
  targetLag: ContractTargetLag;
}>> {
  const resolved = resolveHereWorkspace === undefined
    ? { kind: "unappointed" } as const
    : await resolveHereWorkspace(contractId);
  if (resolved.kind === "failed") {
    return {
      appointed: undefined,
      workspaceObservation: { kind: "failed", diagnostic: resolved.diagnostic },
      targetLag: targetObservation === null ? { kind: "none" } : { kind: "unknown" },
    };
  }
  if (resolved.kind === "unappointed") {
    return {
      appointed: undefined,
      workspaceObservation: { kind: "unappointed" },
      targetLag: targetObservation === null ? { kind: "none" } : { kind: "unknown" },
    };
  }
  const [workspaceObservation, targetLag] = await Promise.all([
    observeWorkspace(repository, { kind: "here" }, resolved.path),
    observeTargetLag(repository, resolved.path, targetObservation?.head),
  ]);
  return { appointed: undefined, workspaceObservation, targetLag };
}

type ContractRowInput = Readonly<{
  repository: GitRepository;
  state: ContractState;
  bindAt: string;
  lastJournalAt: string;
  targetObservation: ContractRow["targetObservation"];
  register: PlaceRegister;
  resolveHereWorkspace?: HereWorkspaceObservationResolver;
}>;

async function rowFor(input: ContractRowInput): Promise<ContractRow> {
  const { repository, state, bindAt, lastJournalAt, targetObservation, register, resolveHereWorkspace } = input;
  const workspace = state.coordinates.workspace;
  const gates = gateReports(state);
  const { appointed, workspaceObservation, targetLag } = workspace === "worktree"
    ? await managedWorkspaceFacts(repository, state, register, targetObservation)
    : await hereWorkspaceFacts(repository, state.id, targetObservation, resolveHereWorkspace);
  return {
    id: state.id,
    title: titleFor(state),
    phase: phaseFor(state),
    phaseAt: phaseAtFor(state, bindAt),
    lastJournalAt,
    disposition: state.terminal === null ? "active" : "terminal",
    workspace,
    worktreePath: appointed === undefined ? null : worktreePath(repository, appointed.place),
    workspaceObservation,
    target: state.coordinates.target ?? null,
    targetLag,
    delivery: state.delivery === null || state.currentIntegration === null
      ? null
      : { ...state.delivery.data, integration: state.currentIntegration },
    targetObservation,
    gates: {
      reports: gates.reports.map((report) => ({ gate: report.gate, current: report.current })),
      satisfied: gates.satisfied,
    },
  };
}

/** Build the Contract board from one immutable git observation. */
export async function readContractBoard(
  observation: GitReadObservation,
  selected?: ContractId,
  resolveHereWorkspace?: HereWorkspaceObservationResolver,
): Promise<ContractBoard> {
  if (selected !== undefined) {
    const contract = await readContractObservation(observation, selected, resolveHereWorkspace);
    return {
      root: observation.repository.primaryWorktree,
      state: observation.snapshot.commit as SnapshotId | null,
      rows: contract.kind === "missing" ? [] : [contract.row],
    };
  }
  const observed = await observeActiveContractWorld(observation);
  const register = await readPlaceRegister(observation.repository);
  const rows: Promise<ContractRow>[] = [];
  for (const value of observed.contracts.values()) {
    if (value.state === null) continue;
    const state = value.state;
    const bindAt = value.entries[0]!.at;
    const lastJournalAt = lastJournalAtFor(value.entries);
    rows.push(observeDeliveryTargetAt(observation, state).then((target) => rowFor({
      repository: observation.repository,
      state,
      bindAt,
      lastJournalAt,
      targetObservation: target,
      register,
      ...(resolveHereWorkspace === undefined ? {} : { resolveHereWorkspace }),
    })));
  }
  return { root: observation.repository.primaryWorktree, state: observed.snapshot, rows: await Promise.all(rows) };
}

/** Observe one Contract and its target from one fresh ref epoch. */
export async function readContractObservation(
  observation: GitReadObservation,
  id: ContractId,
  resolveHereWorkspace?: HereWorkspaceObservationResolver,
): Promise<ContractObservation> {
  const observed = await observeContractsForAdmissionInObservationAt(observation, [id]);
  const record = observed.journals.get(id);
  if (record === undefined) throw new Error(`missing requested Contract observation: ${id}`);
  const state = record.state;
  return state === null
    ? { kind: "missing", id }
    : {
        kind: "present",
        row: await rowFor({
          repository: observation.repository,
          state,
          bindAt: record.entries[0]!.at,
          lastJournalAt: lastJournalAtFor(record.entries),
          targetObservation: await observeDeliveryTargetAt(observation, state),
          register: await readPlaceRegister(observation.repository),
          ...(resolveHereWorkspace === undefined ? {} : { resolveHereWorkspace }),
        }),
      };
}

/** Observe one Contract and its target from one fresh ref epoch. */
export async function readContractObservationAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
  resolveHereWorkspace?: HereWorkspaceObservationResolver,
): Promise<ContractObservation> {
  return withContractReadObservationAt(
    repository,
    channel,
    id,
    async (observation) => await readContractObservation(observation, id, resolveHereWorkspace),
  );
}
