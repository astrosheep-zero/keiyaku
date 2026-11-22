import { errorCategory } from "../../errors.js";
import { z } from "zod";
import { contractIdSchema, contractJournalPaths, snapshotIdSchema } from "../../git/identity.js";
import { gateReportSchema, gateCurrentSchema, requirementReportSchema } from "../result-leaves.js";
import {
  contractJournal,
  countActiveContractJournals,
  deliveryTargetObserver,
  observeContractJournals,
  observeContractView,
  observeReadableContractJournals,
  withContractReadObservationAt,
} from "../../git/observe.js";
import { decodeContractDocument } from "../../document/decode.js";
import { observeTargetLag, observeWorkspace, workspaceHasUnmergedPaths, worktreePath } from "../../git/workspace.js";
import { readPlaceRegister, type PlaceRegister } from "../../workspace-place.js";
import type {
  ContractTargetLag as GitContractTargetLag,
  ContractWorkspaceObservation,
  HandoffReceiptCoordinate,
} from "../../git/workspace.js";
import type { GitRepository } from "../../git/process.js";
import {
  withGitTargetedReadObservation,
  type GitDecodeChannel,
  type GitReadObservation,
} from "../../git/read-observation.js";
import { gateReports, type GateReport } from "../../core/facts/gate.js";
import { contractState } from "../../core/facts/observation.js";
import { verificationRequirement } from "../../verification/declaration.js";
import {
  targetName,
  type ContractId,
  type ContractState,
  type JournalEntry,
  type SnapshotId,
} from "../../core/facts/types.js";
import { projectBoundedList, type LifecycleSelection } from "../../bounded-list.js";
import { observeCurrentPhysicalIssue } from "./observation.js";

const phaseSchema = z.enum(["bound", "claimed", "abandoned"]);
export type ContractPhase = z.output<typeof phaseSchema>;

export function contractLifecycle(phase: ContractPhase): "active" | "settled" {
  return phase === "bound" ? "active" : "settled";
}

export const contractAttentionSchema = z.union([
  z.strictObject({ kind: z.literal("workspace-unavailable"), path: z.string().min(1) }).readonly(),
  z.strictObject({ kind: z.literal("workspace-unappointed") }).readonly(),
  z.strictObject({ kind: z.literal("workspace-failed"), path: z.string().min(1), diagnostic: z.string() }).readonly(),
  z
    .strictObject({
      kind: z.literal("merge-in-progress"),
      path: z.string().min(1),
      conflicts: z.number().int().positive().exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("target-behind"),
      behind: z.number().int().positive(),
      subject: z.string().min(1).exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("target-unknown"), subject: z.string().min(1).exactOptional() }).readonly(),
]);
export type ContractAttention = z.output<typeof contractAttentionSchema>;

export const contractSummarySchema = z
  .strictObject({
    id: contractIdSchema,
    title: z.string().min(1).exactOptional(),
    phase: phaseSchema,
    phaseAt: z.string(),
    delivered: z.literal(true).exactOptional(),
    gates: z.array(gateReportSchema).min(1).readonly().exactOptional(),
    attention: z.array(contractAttentionSchema).min(1).readonly().exactOptional(),
  })
  .readonly();
export type ContractSummary = z.output<typeof contractSummarySchema>;

export const contractCatalogueSchema = z
  .strictObject({
    kind: z.literal("contract-catalogue"),
    observedAt: z.string(),
    rows: z.array(contractSummarySchema).min(1).readonly().exactOptional(),
    more: z.literal(true).exactOptional(),
    skipped: z.number().int().positive().exactOptional(),
  })
  .readonly();
export type ContractCatalogue = z.output<typeof contractCatalogueSchema>;

const indexedRequirementSchema = requirementReportSchema
  .unwrap()
  .extend({ index: z.number().int().positive().exactOptional() })
  .readonly();
const statusGateSchema = gateReportSchema
  .unwrap()
  .extend({ requirements: z.array(indexedRequirementSchema).readonly() })
  .readonly();
const workspaceCountsSchema = z
  .strictObject({
    staged: z.number().int().positive().exactOptional(),
    unstaged: z.number().int().positive().exactOptional(),
    untracked: z.number().int().positive().exactOptional(),
    submodules: z.number().int().positive().exactOptional(),
  })
  .readonly();
export const contractDetailWorkspaceSchema = z.union([
  z
    .strictObject({
      kind: z.literal("present"),
      path: z.string().min(1),
      counts: workspaceCountsSchema.exactOptional(),
      merge: z.array(z.string()).readonly().exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("unavailable"), path: z.string().min(1) }).readonly(),
  z.strictObject({ kind: z.literal("unappointed") }).readonly(),
]);
export type ContractDetailWorkspace = z.output<typeof contractDetailWorkspaceSchema>;

export const contractDetailTargetObservationSchema = z.union([
  z.strictObject({ kind: z.literal("moved"), before: snapshotIdSchema, after: snapshotIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("unknown") }).readonly(),
]);
export type ContractDetailTargetObservation = z.output<typeof contractDetailTargetObservationSchema>;

export const contractDetailSchema = z
  .strictObject({
    kind: z.literal("contract"),
    id: contractIdSchema,
    title: z.string().min(1).exactOptional(),
    phase: phaseSchema,
    workspace: contractDetailWorkspaceSchema,
    target: z.string().exactOptional(),
    targetLag: z.number().int().nonnegative().exactOptional(),
    targetLagUnavailable: z.literal(true).exactOptional(),
    delivery: z.strictObject({ candidate: snapshotIdSchema, integration: snapshotIdSchema }).readonly().exactOptional(),
    targetObservation: contractDetailTargetObservationSchema.exactOptional(),
    gates: z.array(statusGateSchema).min(1).readonly().exactOptional(),
    after: z
      .array(
        z.strictObject({ contractId: contractIdSchema, state: z.enum(["active", "abandoned", "missing"]) }).readonly(),
      )
      .min(1)
      .readonly()
      .exactOptional(),
    issue: z
      .union([
        z.strictObject({ kind: z.literal("target-checkout-retained") }).readonly(),
        z.strictObject({ kind: z.literal("unavailable"), diagnostic: z.string() }).readonly(),
      ])
      .exactOptional(),
    abandonNote: z.string().exactOptional(),
  })
  .readonly();
export type ContractDetail = z.output<typeof contractDetailSchema>;

export const contractObservationSchema = z.union([
  z.strictObject({ kind: z.literal("missing"), id: contractIdSchema }).readonly(),
  contractDetailSchema,
]);

export type ContractGate = z.output<typeof gateReportSchema>;
export type ContractGateCurrent = z.output<typeof gateCurrentSchema>;
export type ContractGateReport = z.output<typeof statusGateSchema>;
export type { ContractWorkspaceObservation };
export type ContractAfterEdge = NonNullable<ContractDetail["after"]>[number];
export type ContractObservation = z.output<typeof contractObservationSchema>;

export type ContractMembership = Pick<ContractDetail, "id" | "phase" | "workspace">;

export function readContractCount(observation: GitReadObservation): number {
  return countActiveContractJournals(observation);
}

const count = z.number().int().nonnegative();
export const activeContractCountsSchema = z
  .strictObject({
    total: count,
    awaitingReview: count,
    conflicts: z.strictObject({ known: count, unavailable: count }).readonly(),
  })
  .readonly();
export const currentContractSummarySchema = z
  .strictObject({ id: contractIdSchema, state: z.enum(["bound", "delivered", "awaiting-review", "conflict"]) })
  .readonly();

type ActiveContractSummary = Readonly<{
  counts: z.output<typeof activeContractCountsSchema>;
  currentContract?: z.output<typeof currentContractSummarySchema>;
}>;

/** Count one complete active journal observation, with only the needed workspace evidence. */
export async function readActiveContractSummary(
  observation: GitReadObservation,
  invocationWorktree?: string,
): Promise<ActiveContractSummary> {
  const { repository } = observation;
  const active = [...(await observeContractJournals(observation, "active")).values()].flatMap(({ state }) =>
    state !== null && contractLifecycle(phaseFor(state)) === "active" ? [state] : [],
  );
  const register = active.length === 0 ? undefined : await readPlaceRegister(repository).catch(() => undefined);
  const conflicts = { known: 0, unavailable: 0 };
  let awaitingReview = 0;
  let currentContract: ActiveContractSummary["currentContract"];
  for (const state of active) {
    const delivered = state.delivery !== null;
    const awaitsReview =
      delivered &&
      gateReports(state).reports.some(
        (report) =>
          report.gate === "reviewed" && report.requirements.some(({ current }) => current.kind !== "attested"),
      );
    if (awaitsReview) awaitingReview++;
    const path = register === undefined ? undefined : appointedWorkspace(repository, register, state)?.workspace;
    const conflict =
      path === undefined ? undefined : await workspaceHasUnmergedPaths(repository, path).catch(() => undefined);
    if (conflict === undefined) conflicts.unavailable++;
    else if (conflict) conflicts.known++;
    if (path !== undefined && path === invocationWorktree) {
      currentContract = {
        id: state.id,
        state: conflict ? "conflict" : awaitsReview ? "awaiting-review" : delivered ? "delivered" : "bound",
      };
    }
  }
  return {
    counts: { total: active.length, awaitingReview, conflicts },
    ...(currentContract === undefined ? {} : { currentContract }),
  };
}

/** Selection observes journals and appointments, never physical state or dependencies. */
export async function readContractMembership(
  observation: GitReadObservation,
  ids?: readonly ContractId[],
): Promise<readonly ContractMembership[]> {
  const contracts = await observeContractJournals(observation, ids ?? "active");
  const register = await readPlaceRegister(observation.repository);
  return [...contracts.values()].flatMap(({ state }) => {
    if (state === null) return [];
    const appointed = appointedWorkspace(observation.repository, register, state);
    return [
      {
        id: state.id,
        phase: phaseFor(state),
        workspace:
          appointed === undefined
            ? { kind: "unappointed" as const }
            : { kind: "present" as const, path: appointed.workspace },
      },
    ];
  });
}

export function readContractMembershipAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  ids?: readonly ContractId[],
): Promise<readonly ContractMembership[]> {
  return withGitTargetedReadObservation(
    repository,
    channel,
    ids === undefined ? { subtrees: ["contracts/active"] } : { paths: ids.flatMap(contractJournalPaths) },
    (observation) => readContractMembership(observation, ids),
  );
}

function documentFor(state: ContractState): ReturnType<typeof decodeContractDocument> | undefined {
  try {
    return decodeContractDocument(state.terms.document.bytes);
  } catch (error) {
    if (errorCategory(error) === "invalid-input") return undefined;
    throw error;
  }
}

function titleFor(document: ReturnType<typeof decodeContractDocument> | undefined): string | undefined {
  const title = document?.title;
  return title === undefined || title.trim() === "" ? undefined : title;
}

function phaseFor(state: ContractState): ContractPhase {
  if (state.terminal?.kind === "claimed") return "claimed";
  if (state.terminal?.kind === "abandoned") return "abandoned";
  return "bound";
}

function phaseAtFor(state: Pick<ContractState, "terminal" | "delivery">, bindAt: string): string {
  return state.terminal?.at ?? state.delivery?.at ?? bindAt;
}

function lastJournalAtFor(entries: readonly Pick<JournalEntry, "at">[]): string {
  const last = entries.at(-1);
  if (last === undefined) throw new Error("present Contract journal is empty");
  return last.at;
}

function compactGate({ gate, current }: GateReport): ContractGate {
  return { gate, current: current.kind === "attested" ? current.verdict : current.kind };
}

export function summaryFor({ state, bindAt }: Pick<SelectedContractState, "state" | "bindAt">): ContractSummary {
  const document = documentFor(state);
  const title = titleFor(document);
  const gates = gateReports(state).reports.map(compactGate);
  return {
    id: state.id,
    ...(title === undefined ? {} : { title }),
    phase: phaseFor(state),
    phaseAt: phaseAtFor(state, bindAt),
    ...(state.delivery === null ? {} : { delivered: true }),
    ...(gates.length === 0 ? {} : { gates }),
  };
}

function appointedWorkspace(
  repository: GitRepository,
  register: PlaceRegister,
  state: ContractState,
): HandoffReceiptCoordinate | undefined {
  const place = register.get(state.id);
  return place === undefined ? undefined : { contractId: state.id, place, workspace: worktreePath(repository, place) };
}

function detailCounts(
  counts: Extract<ContractWorkspaceObservation, { kind: "clean" | "dirty" }>["counts"],
): NonNullable<Extract<ContractDetailWorkspace, { kind: "present" }>["counts"]> {
  return {
    ...(counts.staged === 0 ? {} : { staged: counts.staged }),
    ...(counts.unstaged === 0 ? {} : { unstaged: counts.unstaged }),
    ...(counts.untracked === 0 ? {} : { untracked: counts.untracked }),
    ...(counts.submodules === 0 ? {} : { submodules: counts.submodules }),
  };
}

function detailWorkspace(path: string, observed: ContractWorkspaceObservation): ContractDetailWorkspace {
  switch (observed.kind) {
    case "clean":
    case "dirty": {
      const counts = detailCounts(observed.counts);
      return {
        kind: "present",
        path,
        ...(Object.keys(counts).length === 0 ? {} : { counts }),
        ...(observed.merge === null ? {} : { merge: observed.merge.unmergedPaths }),
      };
    }
    case "unavailable":
      return { kind: "unavailable", path };
    case "unappointed":
      return { kind: "unappointed" };
    case "failed":
      throw new Error(observed.diagnostic);
  }
}

function detailTargetObservation(
  observed: Readonly<{ head: SnapshotId | null; drift: boolean }> | null,
  state: ContractState,
): ContractDetailTargetObservation | undefined {
  if (observed === null) return undefined;
  if (observed.head === null) return { kind: "unknown" };
  const integration = state.currentIntegration;
  const expected = state.terminal?.kind === "claimed" ? integration?.snapshot : integration?.predecessor;
  return observed.drift && expected !== undefined
    ? { kind: "moved", before: expected, after: observed.head }
    : undefined;
}

type RawTargetObservation = Readonly<{ head: SnapshotId | null; drift: boolean }> | null;

async function managedWorkspaceFacts(
  repository: GitRepository,
  state: ContractState,
  appointed: HandoffReceiptCoordinate | undefined,
  targetObservation: RawTargetObservation,
): Promise<
  Readonly<{
    workspace: ContractDetailWorkspace;
    targetLag: GitContractTargetLag;
  }>
> {
  if (appointed === undefined) {
    return {
      workspace: { kind: "unappointed" },
      targetLag: { kind: state.coordinates.target === undefined ? "none" : "unknown" },
    };
  }
  const path = appointed.workspace;
  const [workspaceObservation, targetLag] = await Promise.all([
    observeWorkspace(repository, { kind: "worktree", path }, path),
    observeTargetLag(repository, path, targetObservation?.head),
  ]);
  return { workspace: detailWorkspace(path, workspaceObservation), targetLag };
}

function summaryAttention({
  workspace,
  targetLag,
}: Awaited<ReturnType<typeof managedWorkspaceFacts>>): readonly ContractAttention[] {
  const attention: ContractAttention[] = [];
  switch (workspace.kind) {
    case "unavailable":
      attention.push({ kind: "workspace-unavailable", path: workspace.path });
      break;
    case "unappointed":
      attention.push({ kind: "workspace-unappointed" });
      break;
    case "present":
      if (workspace.merge !== undefined) {
        const conflicts = workspace.merge.length;
        attention.push({ kind: "merge-in-progress", path: workspace.path, ...(conflicts === 0 ? {} : { conflicts }) });
      }
  }
  if (targetLag.kind !== "none") {
    const subject = targetLag.subject === undefined ? {} : { subject: targetLag.subject.path };
    if (targetLag.kind === "unknown") attention.push({ kind: "target-unknown", ...subject });
    else if (targetLag.behind > 0) attention.push({ kind: "target-behind", behind: targetLag.behind, ...subject });
  }
  return attention;
}

function afterEndpoint(state: ContractState | null): ContractAfterEdge["state"] | undefined {
  if (state === null) return "missing";
  if (state.terminal?.kind === "claimed") return undefined;
  return state.terminal?.kind === "abandoned" ? "abandoned" : "active";
}

function afterEdges(
  state: ContractState,
  endpoints: ReadonlyMap<ContractId, ContractState | null>,
): readonly ContractAfterEdge[] {
  return state.terms.after.flatMap((contractId) => {
    const endpoint = afterEndpoint(contractState(endpoints, contractId));
    return endpoint === undefined ? [] : [{ contractId, state: endpoint }];
  });
}

/** Observe one Contract and its target from one fresh ref epoch. */
export async function readContractObservation(
  observation: GitReadObservation,
  id: ContractId,
): Promise<ContractObservation> {
  const { decision } = await observeContractView(observation, [id], { after: true });
  const state = contractState(decision, id);
  if (state === null) return { kind: "missing", id };
  const repository = observation.repository;
  const register = await readPlaceRegister(repository);
  const workspace = appointedWorkspace(repository, register, state);
  const rawTargetObservation = await deliveryTargetObserver(observation)(state);
  const after = afterEdges(state, decision);
  const document = documentFor(state);
  const indexes = new Map<string, number>();
  document?.verification.forEach((declaration, index) => {
    const requirement = verificationRequirement(declaration);
    if (!indexes.has(requirement)) indexes.set(requirement, index + 1);
  });
  const facts = await managedWorkspaceFacts(repository, state, workspace, rawTargetObservation);
  const gates = gateReports(state).reports.map((report) => {
    const requirements =
      report.gate !== "verified"
        ? report.requirements
        : report.requirements.map((requirement) => {
            const index = indexes.get(requirement.requirement);
            return index === undefined ? requirement : { ...requirement, index };
          });
    return { ...compactGate(report), requirements };
  });
  const title = titleFor(document);
  const targetObservation = detailTargetObservation(rawTargetObservation, state);
  const row: ContractDetail = {
    kind: "contract",
    id: state.id,
    ...(title === undefined ? {} : { title }),
    phase: phaseFor(state),
    workspace: facts.workspace,
    ...(state.coordinates.target === undefined ? {} : { target: targetName(state.coordinates.target) }),
    ...(facts.targetLag.kind === "counted"
      ? { targetLag: facts.targetLag.behind }
      : facts.targetLag.kind === "unknown"
        ? { targetLagUnavailable: true }
        : {}),
    ...(state.delivery === null
      ? {}
      : {
          delivery: {
            candidate: state.delivery.data.tenderSnapshot,
            integration: (state.currentIntegration ?? state.delivery.data.integration).snapshot,
          },
        }),
    ...(targetObservation === undefined ? {} : { targetObservation }),
    ...(gates.length === 0 ? {} : { gates }),
    ...(after.length === 0 ? {} : { after }),
    ...(state.terminal?.kind === "abandoned" && state.terminal.data.note !== undefined
      ? { abandonNote: state.terminal.data.note }
      : {}),
  };
  return await selectedDetailWithIssue(repository, state, row, rawTargetObservation);
}

type SelectedContractState = Readonly<{
  state: ContractState;
  bindAt: string;
  lastJournalAt: string;
}>;

function compareRecentContracts(left: SelectedContractState, right: SelectedContractState): number {
  return (
    right.lastJournalAt.localeCompare(left.lastJournalAt) ||
    Buffer.compare(Buffer.from(left.state.id), Buffer.from(right.state.id))
  );
}

function selectedContractStates(
  contracts: ReadonlyMap<ContractId, Readonly<{ state: ContractState | null; entries: readonly JournalEntry[] }>>,
): readonly SelectedContractState[] {
  return [...contracts.values()].flatMap((record) =>
    record.state === null
      ? []
      : [
          {
            state: record.state,
            bindAt: record.entries[0]!.at,
            lastJournalAt: lastJournalAtFor(record.entries),
          },
        ],
  );
}

export type ContractCatalogueReadPolicy = "strict" | "readable";

/**
 * Observe selected lifecycle classes under one recent-journal order and bound,
 * from one immutable Git observation. Settled rows never observe physical state.
 */
export async function readContractCatalogue(
  observation: GitReadObservation,
  limit?: number,
  selection: LifecycleSelection = "active",
  policy: ContractCatalogueReadPolicy = "strict",
): Promise<ContractCatalogue> {
  const observedAt = new Date().toISOString();
  const journalSelection = selection === "all" ? undefined : selection === "active" ? "active" : "terminal";
  const { journals: contracts, skipped } =
    policy === "readable"
      ? await observeReadableContractJournals(observation, journalSelection)
      : { journals: await observeContractJournals(observation, journalSelection), skipped: 0 };
  const matching = selectedContractStates(contracts)
    .filter(({ state }) => selection === "all" || contractLifecycle(phaseFor(state)) === selection)
    .sort(compareRecentContracts);
  const selected = limit === undefined ? { rows: matching, hasMore: false } : projectBoundedList(matching, limit);
  const register = selected.rows.some(({ state }) => contractLifecycle(phaseFor(state)) === "active")
    ? await readPlaceRegister(observation.repository)
    : undefined;
  const observeTarget = deliveryTargetObserver(observation);
  const rows = await Promise.all(
    selected.rows.map(async (selected) => {
      const { state } = selected;
      if (contractLifecycle(phaseFor(state)) === "settled") return summaryFor(selected);
      const attention = summaryAttention(
        await managedWorkspaceFacts(
          observation.repository,
          state,
          appointedWorkspace(observation.repository, register!, state),
          await observeTarget(state),
        ),
      );
      return { ...summaryFor(selected), ...(attention.length === 0 ? {} : { attention }) };
    }),
  );
  return {
    kind: "contract-catalogue",
    observedAt,
    ...(rows.length === 0 ? {} : { rows }),
    ...(selected.hasMore ? { more: true as const } : {}),
    ...(skipped === 0 ? {} : { skipped }),
  };
}

/**
 * Observe only a Contract's phase from one immutable git observation, without
 * workspace or target reads.
 */
export async function readContractPhase(
  observation: GitReadObservation,
  id: ContractId,
): Promise<ContractPhase | null> {
  const { state } = contractJournal(await observeContractJournals(observation, [id]), id);
  return state === null ? null : phaseFor(state);
}

/** The exact selected read carries its physical issue; only that physical read can turn unavailable. */
async function selectedDetailWithIssue(
  repository: GitRepository,
  state: ContractState,
  row: ContractDetail,
  targetObservation: RawTargetObservation,
): Promise<ContractDetail> {
  const delivery = state.delivery;
  if (delivery === null) return row;
  const integration = state.currentIntegration ?? delivery.data.integration;
  try {
    const issue = await observeCurrentPhysicalIssue(
      repository,
      {
        phase: row.phase,
        target: state.coordinates.target,
        delivery: row.delivery,
        observedHead: targetObservation?.head ?? null,
      },
      integration.predecessor,
    );
    return issue === undefined ? row : { ...row, issue };
  } catch (error) {
    return {
      ...row,
      issue: { kind: "unavailable", diagnostic: error instanceof Error ? error.message : String(error) },
    };
  }
}

/** Observe one Contract and its target from one fresh ref epoch. */
export async function readContractObservationAt(
  repository: GitRepository,
  channel: GitDecodeChannel,
  id: ContractId,
): Promise<ContractObservation> {
  return withContractReadObservationAt(
    repository,
    channel,
    id,
    async (observation) => await readContractObservation(observation, id),
  );
}
