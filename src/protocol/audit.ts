import { readDeliveryDiff, readDeliveryScope, type DeliveryDiffScope } from "../git/integration.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { activeContract, documentIsCurrent } from "../core/facts/observation.js";
import type { ChangeId, ContractState, DeliverData, SnapshotId } from "../core/facts/types.js";
import { adjudicateAuditTarget, type AuditTargetAnswer } from "../git/target-placement.js";
import { readManagedWorktreeAppointment, type ManagedWorktreeAppointment } from "../workspace-place.js";
import { verifyDelivery } from "./intent.js";
import { accepted, admitted } from "./outcome.js";
import { prepareDelivery } from "./deliver.js";
import type {
  DeliveryPreparationRefusal,
  DocumentDerivation,
  IntentOutcome,
  MutationOperationInput,
  RepositoryScope,
  VerificationStop,
} from "./operations.js";
import { timestamp, unpackVerificationOutcome } from "./operations.js";
export { decodeAuditReport } from "./result-codec.js";

type AuditWorkspace = Readonly<{
  kind: "worktree";
  path: string;
}>;
type DiffScope = DeliveryDiffScope;
export type AuditReport = Readonly<{
  candidate:
    | Readonly<{ kind: "blocked"; refusal: DeliveryPreparationRefusal }>
    | Readonly<{
        kind: "ready";
        workspace: AuditWorkspace;
        identity: DeliverData;
        scope: DiffScope;
        diff?: string;
      }>;
  verification:
    | Readonly<{ kind: "not-run" }>
    | Readonly<{ kind: "satisfied"; passed: number; total: number; summary?: string }>
    | Readonly<{ kind: "unsatisfied"; passed: number; total: number; summary?: string }>
    | Readonly<{ kind: "stopped"; stop: VerificationStop }>;
  target: Readonly<{ kind: "not-observed" }> | AuditTargetAnswer;
  delivery?: Readonly<{ changeId: ChangeId; relation: "identical" | "differs" }>;
}>;

type AuditOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument?: (state: ContractState) => DocumentDerivation;
    requireBranchesToBeUpToDate?: boolean;
    includeDirty?: boolean;
    showDiff?: boolean;
    signal?: AbortSignal;
  }>;

async function auditWorkspace(
  repository: RepositoryScope,
  state: ContractState,
): Promise<
  | Readonly<{
      kind: "ready";
      answer: AuditWorkspace;
      appointment?: Extract<ManagedWorktreeAppointment, { kind: "appointed" }>;
    }>
  | Readonly<{ kind: "unappointed" }>
> {
  const appointed = await readManagedWorktreeAppointment(repository, state.id);
  if (appointed.kind === "failed") throw new Error(appointed.diagnostic);
  if (appointed.kind === "unappointed") return appointed;
  return { kind: "ready", answer: { kind: "worktree", path: appointed.path }, appointment: appointed };
}

function auditDeliveryRelation(state: ContractState, candidate: DeliverData): AuditReport["delivery"] {
  const recorded = state.delivery?.data.integration.changeId;
  if (recorded === undefined) return undefined;
  return { changeId: recorded, relation: recorded === candidate.integration.changeId ? "identical" : "differs" };
}

async function auditCandidateVerification(
  input: AuditOperationInput,
  state: ContractState,
  snapshot: SnapshotId,
  definition: NonNullable<DocumentDerivation["verification"]["data"]>,
): Promise<ReturnType<typeof unpackVerificationOutcome>> {
  const verification = await verifyDelivery({
    channel: input.channel,
    repository: input.scope,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    at: timestamp(),
    state,
    snapshot,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    verification: definition,
  });
  if (verification === null) throw new Error("audit verification preparation unexpectedly produced no attempt");
  return unpackVerificationOutcome(verification);
}

function auditVerificationAnswer(
  verified: ReturnType<typeof unpackVerificationOutcome> | undefined,
): AuditReport["verification"] {
  if (verified === undefined) return { kind: "not-run" };
  if (verified.stop !== undefined) return { kind: "stopped", stop: verified.stop };
  if (verified.counts === undefined) throw new Error("terminal Verification is missing producer counts");
  return {
    kind: verified.counts.verdict,
    passed: verified.counts.passed,
    total: verified.counts.total,
    ...(verified.counts.summary === undefined ? {} : { summary: verified.counts.summary }),
  };
}

async function readyAuditCandidate(
  repository: RepositoryScope,
  candidate: DeliverData,
  workspace: AuditWorkspace,
  showDiff: boolean,
): Promise<Extract<AuditReport["candidate"], { kind: "ready" }>> {
  const predecessor = candidate.integration.predecessor;
  const snapshot = candidate.integration.snapshot;
  const scope = await readDeliveryScope(repository, predecessor, snapshot, showDiff);
  const diff = showDiff ? await readDeliveryDiff(repository, predecessor, snapshot) : undefined;
  return {
    kind: "ready",
    workspace,
    identity: candidate,
    scope,
    ...(diff === undefined || diff === null ? {} : { diff }),
  };
}

async function auditTargetAnswer(
  repository: RepositoryScope,
  state: ContractState,
  candidate: DeliverData,
): Promise<AuditReport["target"]> {
  const target = state.coordinates.target;
  if (target === undefined) return { kind: "not-observed" };
  return await adjudicateAuditTarget(repository, {
    contractId: state.id,
    coordinates: { ...state.coordinates, target },
    predecessor: candidate.integration.predecessor,
    candidate: candidate.integration.snapshot,
  });
}

function blockedAudit(refusal: DeliveryPreparationRefusal): AuditReport {
  return {
    candidate: { kind: "blocked", refusal },
    verification: { kind: "not-run" },
    target: { kind: "not-observed" },
  };
}

function completedAudit(
  state: ContractState,
  verified: ReturnType<typeof unpackVerificationOutcome> | undefined,
  value: AuditReport,
): IntentOutcome<AuditReport> {
  const obligations = {
    ...(verified?.cleanup === undefined ? {} : { cleanup: verified.cleanup }),
    ...(verified?.leak === undefined ? {} : { leak: verified.leak }),
  };
  return verified?.admission === undefined
    ? accepted(state, [], value, undefined, obligations)
    : { ...admitted(verified.admission, value), ...obligations };
}

export async function auditOperation(input: AuditOperationInput): Promise<IntentOutcome<AuditReport>> {
  const observed = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = activeContract(observed.decision, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  const derivation = input.deriveDocument?.(state);
  if (derivation === undefined || !documentIsCurrent(state, derivation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }
  if (derivation.verification.kind === "refused") return { kind: "refused", refusal: derivation.verification.refusal };
  const workspace = await auditWorkspace(input.scope, state);
  if (workspace.kind === "unappointed") {
    return accepted(state, [], blockedAudit({ kind: "worktree-missing", contractId: state.id }));
  }
  const prepared = await prepareDelivery(
    input.scope,
    {
      contractId: state.id,
      coordinates: state.coordinates,
      ...(workspace.appointment === undefined ? {} : { appointment: workspace.appointment }),
    },
    {
      title: derivation.title,
      document: derivation.bytes,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate ?? false,
      includeDirty: input.includeDirty ?? false,
    },
  );
  if (prepared.kind === "refused") return accepted(state, [], blockedAudit(prepared.refusal));
  const verified =
    derivation.verification.data === null
      ? undefined
      : await auditCandidateVerification(
          input,
          state,
          prepared.data.integration.snapshot,
          derivation.verification.data,
        );
  const verification = auditVerificationAnswer(verified);
  const delivery = auditDeliveryRelation(state, prepared.data);
  const value: AuditReport = {
    candidate: await readyAuditCandidate(input.scope, prepared.data, workspace.answer, input.showDiff === true),
    verification,
    target:
      verification.kind === "stopped"
        ? { kind: "not-observed" }
        : await auditTargetAnswer(input.scope, state, prepared.data),
    ...(delivery === undefined ? {} : { delivery }),
  };
  return completedAudit(state, verified, value);
}
