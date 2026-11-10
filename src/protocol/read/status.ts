import { z } from "zod";
import { contractIdSchema, snapshotIdSchema } from "../../git/identity.js";
import { type ContractTargetLag as GitContractTargetLag } from "../../git/workspace.js";
import { gateSchema } from "../result-leaves.js";
import {
  observeActiveContractWorld,
  observeContractsForAdmissionInObservationAt,
  deliveryTargetObserver,
  withContractReadObservationAt,
} from "../../git/observe.js";
import { decodeContractDocument } from "../../body/decode.js";
import { observeTargetLag, observeWorkspace, worktreePath } from "../../git/workspace.js";
import { appointmentFor, readPlaceRegister, type PlaceRegister } from "../../workspace-place.js";
import type { ContractWorkspaceObservation, HandoffReceiptCoordinate } from "../../git/workspace.js";
import type { GitRepository } from "../../git/process.js";
import type { GitDecodeChannel, GitReadObservation } from "../../git/read-observation.js";
import { gateReports, type GateCurrent } from "../../core/facts/gate.js";
import { verificationRequirement } from "../../verification/declaration.js";
import { type ContractId, type ContractState, type JournalEntry, type SnapshotId } from "../../core/facts/types.js";
import { projectBoundedList } from "../../bounded-list.js";
import { observeCurrentPhysicalIssue } from "./observation.js";

const phaseSchema = z.enum(["bound", "claimed", "abandoned"]);
export type ContractPhase = z.output<typeof phaseSchema>;

const summaryGateSchema = z
  .strictObject({
    name: gateSchema,
    verdict: z.enum(["missing", "stale", "satisfied", "unsatisfied"]),
  })
  .readonly();
export type ContractSummaryGate = z.output<typeof summaryGateSchema>;

export const contractSummaryAssociationSchema = z.union([
  z.strictObject({ kind: z.literal("debt"), debtId: z.string().min(1) }).readonly(),
  z
    .strictObject({
      kind: z.literal("akuma"),
      akumaId: z.string().min(1),
      aliases: z.array(z.string().min(1)).min(1).readonly().exactOptional(),
      aliasesUnavailable: z.literal(true).exactOptional(),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal("unavailable"),
      source: z.enum(["holder", "roster"]),
      diagnostic: z.string(),
    })
    .readonly(),
]);
export type ContractSummaryAssociation = z.output<typeof contractSummaryAssociationSchema>;

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
    phaseAt: z.string(),
    delivered: z.literal(true).exactOptional(),
    gates: z.array(summaryGateSchema).min(1).readonly().exactOptional(),
    attention: z.array(contractAttentionSchema).min(1).readonly().exactOptional(),
  })
  .readonly();
export type ContractSummary = z.output<typeof contractSummarySchema>;

export const contractCatalogueSchema = z
  .strictObject({
    observedAt: z.string(),
    rows: z.array(contractSummarySchema).min(1).readonly().exactOptional(),
    more: z.literal(true).exactOptional(),
  })
  .readonly();
export type ContractCatalogue = z.output<typeof contractCatalogueSchema>;

const detailCurrentSchema = z.union([
  z.strictObject({ kind: z.literal("missing") }).readonly(),
  z.strictObject({ kind: z.literal("stale") }).readonly(),
  z
    .strictObject({
      kind: z.literal("attested"),
      verdict: z.enum(["satisfied", "unsatisfied"]),
      summary: z.string().exactOptional(),
    })
    .readonly(),
]);
const rowRequirementSchema = z
  .strictObject({
    requirement: z.string().exactOptional(),
    current: detailCurrentSchema,
    index: z.number().int().positive().exactOptional(),
  })
  .readonly();
const rowGateSchema = z
  .strictObject({
    gate: z.string(),
    requirements: z.array(rowRequirementSchema).readonly(),
  })
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

export const contractDetailTargetLagSchema = z.union([
  z
    .strictObject({
      kind: z.literal("counted"),
      behind: z.number().int().positive().exactOptional(),
    })
    .readonly(),
  z.strictObject({ kind: z.literal("unknown") }).readonly(),
]);
export type ContractDetailTargetLag = z.output<typeof contractDetailTargetLagSchema>;

export const contractDetailTargetObservationSchema = z.union([
  z.strictObject({ kind: z.literal("moved"), before: snapshotIdSchema, after: snapshotIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("unknown") }).readonly(),
]);
export type ContractDetailTargetObservation = z.output<typeof contractDetailTargetObservationSchema>;

export const contractDetailSchema = z
  .strictObject({
    id: contractIdSchema,
    title: z.string().min(1).exactOptional(),
    phase: phaseSchema,
    workspace: contractDetailWorkspaceSchema,
    target: z.string().exactOptional(),
    targetLag: contractDetailTargetLagSchema.exactOptional(),
    delivery: z.strictObject({ candidate: snapshotIdSchema, integration: snapshotIdSchema }).readonly().exactOptional(),
    targetObservation: contractDetailTargetObservationSchema.exactOptional(),
    gates: z.array(rowGateSchema).min(1).readonly().exactOptional(),
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

const dependentSchema = z.strictObject({ contractId: contractIdSchema, phase: phaseSchema }).readonly();
export const contractBoardSchema = z
  .strictObject({
    rows: z
      .array(
        contractDetailSchema
          .unwrap()
          .extend({
            dependents: z.array(dependentSchema).min(1).readonly().exactOptional(),
          })
          .readonly(),
      )
      .readonly(),
  })
  .readonly();
export const contractObservationSchema = z.union([
  z.strictObject({ kind: z.literal("missing"), id: contractIdSchema }).readonly(),
  z.strictObject({ kind: z.literal("present"), row: contractDetailSchema }).readonly(),
]);

export type ContractGateCurrent = z.output<typeof detailCurrentSchema>;
export type ContractGateReport = z.output<typeof rowGateSchema>;
export type ContractTargetLag = ContractDetailTargetLag;
export type { ContractWorkspaceObservation };
export type ContractAfterEdge = NonNullable<ContractDetail["after"]>[number];
export type ContractDependent = z.output<typeof dependentSchema>;
export type ContractBoard = z.output<typeof contractBoardSchema>;
export type ContractObservation = z.output<typeof contractObservationSchema>;

function documentFor(state: ContractState): ReturnType<typeof decodeContractDocument> | undefined {
  try {
    return decodeContractDocument(state.terms.document.bytes);
  } catch (error) {
    if (error instanceof TypeError) return undefined;
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

function summaryVerdict(current: GateCurrent): ContractSummaryGate["verdict"] {
  if (current.kind === "missing") return "missing";
  if (current.kind === "stale") return "stale";
  return current.verdict;
}

function summaryFor({ state, bindAt }: SelectedContractState): ContractSummary {
  const document = documentFor(state);
  const title = titleFor(document);
  const gates = gateReports(state).reports.map((report) => ({
    name: report.gate,
    verdict: summaryVerdict(report.current),
  }));
  return {
    id: state.id,
    ...(title === undefined ? {} : { title }),
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
  const appointed = appointmentFor(register, state.id);
  return appointed === undefined
    ? undefined
    : { contractId: state.id, place: appointed.place, workspace: worktreePath(repository, appointed.place) };
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

function detailTargetLag(lag: GitContractTargetLag): ContractDetailTargetLag | undefined {
  if (lag.kind === "none") return undefined;
  return lag.kind === "counted"
    ? { kind: "counted", ...(lag.behind === 0 ? {} : { behind: lag.behind }) }
    : { kind: "unknown" };
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
    targetLag: ContractDetailTargetLag | undefined;
    lagSubject?: string;
  }>
> {
  if (appointed === undefined) {
    return {
      workspace: { kind: "unappointed" },
      targetLag: state.coordinates.target === undefined ? undefined : { kind: "unknown" },
    };
  }
  const path = appointed.workspace;
  const [workspaceObservation, targetLag] = await Promise.all([
    observeWorkspace(repository, { kind: "worktree", path }, path),
    observeTargetLag(repository, path, targetObservation?.head),
  ]);
  return {
    workspace: detailWorkspace(path, workspaceObservation),
    targetLag: detailTargetLag(targetLag),
    ...(targetLag.kind === "none" || targetLag.subject === undefined ? {} : { lagSubject: targetLag.subject.path }),
  };
}

function summaryAttention({
  workspace,
  targetLag,
  lagSubject,
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
  if (targetLag?.kind === "unknown")
    attention.push({ kind: "target-unknown", ...(lagSubject === undefined ? {} : { subject: lagSubject }) });
  else if (targetLag?.behind !== undefined)
    attention.push({
      kind: "target-behind",
      behind: targetLag.behind,
      ...(lagSubject === undefined ? {} : { subject: lagSubject }),
    });
  return attention;
}

type ContractRowInput = Readonly<{
  repository: GitRepository;
  state: ContractState;
  bindAt: string;
  targetObservation: RawTargetObservation;
  workspace: HandoffReceiptCoordinate | undefined;
  after: readonly ContractAfterEdge[];
  dependents: readonly ContractDependent[];
  physicalIssue: boolean;
}>;

function afterEndpoint(state: ContractState | null | undefined): ContractAfterEdge["state"] | undefined {
  if (state === undefined || state === null) return "missing";
  if (state.terminal?.kind === "claimed") return undefined;
  return state.terminal?.kind === "abandoned" ? "abandoned" : "active";
}

function afterEdges(
  state: ContractState,
  endpoints: ReadonlyMap<ContractId, ContractState | null>,
): readonly ContractAfterEdge[] {
  return state.terms.after.flatMap((contractId) => {
    const endpoint = afterEndpoint(endpoints.get(contractId));
    return endpoint === undefined ? [] : [{ contractId, state: endpoint }];
  });
}

function reverseDependents(id: ContractId, states: readonly SelectedContractState[]): readonly ContractDependent[] {
  return states
    .filter(({ state }) => state.terminal === null && state.terms.after.includes(id))
    .map(({ state }) => ({ contractId: state.id, phase: phaseFor(state) }))
    .sort((left, right) => left.contractId.localeCompare(right.contractId));
}

async function rowFor(input: ContractRowInput): Promise<ContractBoard["rows"][number]> {
  const { repository, state, targetObservation: rawTargetObservation, workspace, after, dependents } = input;
  const document = documentFor(state);
  const indexes = new Map<string, number>();
  document?.verification.forEach((declaration, index) => {
    const requirement = verificationRequirement(declaration);
    if (!indexes.has(requirement)) indexes.set(requirement, index + 1);
  });
  const facts = await managedWorkspaceFacts(repository, state, workspace, rawTargetObservation);
  const gates = gateReports(state).reports.map((report) => ({
    gate: report.gate,
    requirements: report.requirements.map((requirement) => {
      const index = report.gate === "verified" ? indexes.get(requirement.requirement) : undefined;
      const current = requirement.current;
      return {
        ...(index !== undefined
          ? { index }
          : requirement.requirement === `gate:${report.gate}`
            ? {}
            : { requirement: requirement.requirement }),
        current:
          current.kind === "attested"
            ? {
                kind: "attested" as const,
                verdict: current.verdict,
                ...(current.summary === undefined ? {} : { summary: current.summary }),
              }
            : { kind: current.kind },
      };
    }),
  }));
  const title = titleFor(document);
  const targetObservation = detailTargetObservation(rawTargetObservation, state);
  const row = {
    id: state.id,
    ...(title === undefined ? {} : { title }),
    phase: phaseFor(state),
    workspace: facts.workspace,
    ...(state.coordinates.target === undefined
      ? {}
      : {
          target:
            typeof state.coordinates.target === "string"
              ? state.coordinates.target
              : state.coordinates.target.contractId,
        }),
    ...(facts.targetLag === undefined ? {} : { targetLag: facts.targetLag }),
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
    ...(dependents.length === 0 ? {} : { dependents }),
    ...(state.terminal?.kind === "abandoned" && state.terminal.data.note !== undefined
      ? { abandonNote: state.terminal.data.note }
      : {}),
  };
  return input.physicalIssue ? await selectedDetailWithIssue(repository, state, row, rawTargetObservation) : row;
}

async function afterEndpointMap(
  observation: GitReadObservation,
  known: ReadonlyMap<ContractId, ContractState | null>,
  ids: readonly ContractId[],
): Promise<ReadonlyMap<ContractId, ContractState | null>> {
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length === 0) return known;
  const extra = await observeContractsForAdmissionInObservationAt(observation, missing);
  return new Map([...known, ...[...extra.journals].map(([id, record]) => [id, record.state] as const)]);
}

async function hydrateRows(
  observation: GitReadObservation,
  states: readonly SelectedContractState[],
  endpoints: ReadonlyMap<ContractId, ContractState | null>,
  dependentStates: readonly SelectedContractState[] = [],
  physicalIssue = false,
): Promise<readonly ContractBoard["rows"][number][]> {
  const register = await readPlaceRegister(observation.repository);
  const selected = states.map((value) => ({
    ...value,
    workspace: appointedWorkspace(observation.repository, register, value.state),
  }));
  const observeTarget = deliveryTargetObserver(observation);
  return await Promise.all(
    selected.map(
      async ({ state, bindAt, workspace }) =>
        await rowFor({
          repository: observation.repository,
          state,
          bindAt,
          targetObservation: await observeTarget(state),
          workspace,
          after: afterEdges(state, endpoints),
          dependents: reverseDependents(state.id, dependentStates),
          physicalIssue,
        }),
    ),
  );
}

/** Build the complete board by default; a selected detail read retains complete dependency evidence. */
export async function readContractBoard(
  observation: GitReadObservation,
  include?: ContractId,
  detail: "board" | "selected" = "board",
): Promise<ContractBoard> {
  const observed = await observeActiveContractWorld(observation);
  const contracts = new Map(observed.contracts);
  let endpoints = new Map(observed.eligibility);
  if (include !== undefined && !contracts.has(include)) {
    const extra = await observeContractsForAdmissionInObservationAt(observation, [include]);
    const record = extra.journals.get(include);
    if (record === undefined) throw new Error(`missing requested Contract observation: ${include}`);
    contracts.set(include, record);
    endpoints.set(include, record.state);
    if (record.state !== null) {
      endpoints = new Map(await afterEndpointMap(observation, endpoints, record.state.terms.after));
    }
  }
  const states = selectedContractStates(contracts);
  const selected = detail === "selected" ? states.filter(({ state }) => state.id === include) : states;
  const rows = await hydrateRows(observation, selected, endpoints, states);
  return { rows };
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

/**
 * Observe a bounded recent active Contract catalogue, or its complete active set
 * when no bound is selected, from one immutable Git observation.
 */
export async function readContractCatalogue(
  observation: GitReadObservation,
  limit?: number,
): Promise<ContractCatalogue> {
  const observedAt = new Date().toISOString();
  const observed = await observeActiveContractWorld(observation);
  const active = selectedContractStates(observed.contracts)
    .filter(({ state }) => state.terminal === null)
    .sort(compareRecentContracts);
  const selected = limit === undefined ? { rows: active, hasMore: false } : projectBoundedList(active, limit);
  const register = await readPlaceRegister(observation.repository);
  const observeTarget = deliveryTargetObserver(observation);
  const rows = await Promise.all(
    selected.rows.map(async (selected) => {
      const { state } = selected;
      const attention = summaryAttention(
        await managedWorkspaceFacts(
          observation.repository,
          state,
          appointedWorkspace(observation.repository, register, state),
          await observeTarget(state),
        ),
      );
      return { ...summaryFor(selected), ...(attention.length === 0 ? {} : { attention }) };
    }),
  );
  return {
    observedAt,
    ...(rows.length === 0 ? {} : { rows }),
    ...(selected.hasMore ? { more: true as const } : {}),
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
  const observed = await observeContractsForAdmissionInObservationAt(observation, [id]);
  const record = observed.journals.get(id);
  if (record === undefined) throw new Error(`missing requested Contract observation: ${id}`);
  return record.state === null ? null : phaseFor(record.state);
}

/** Observe one Contract and its target from one fresh ref epoch. */
export async function readContractObservation(
  observation: GitReadObservation,
  id: ContractId,
): Promise<ContractObservation> {
  const observed = await observeContractsForAdmissionInObservationAt(observation, [id]);
  const record = observed.journals.get(id);
  if (record === undefined) throw new Error(`missing requested Contract observation: ${id}`);
  const state = record.state;
  if (state === null) return { kind: "missing", id };
  const endpoints = await afterEndpointMap(observation, new Map([[id, state]]), state.terms.after);
  const rows = await hydrateRows(observation, selectedContractStates(observed.journals), endpoints, [], true);
  return { kind: "present", row: rows[0]! };
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
