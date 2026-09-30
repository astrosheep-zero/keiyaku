import { z } from "zod";
import {
  deliverDataSchema,
  deliveryPreparationRefusalSchema,
  verificationStopSchema,
  changeIdSchema,
  verdictSchema,
  entryUlidSchema,
} from "./operations.js";
import { auditTargetAnswerSchema } from "../git/target-placement.js";
import { verificationReuseSchema } from "./intent.js";
import { deliveryDiffScopeSchema, readDeliveryDiff, readDeliveryScope } from "../git/integration.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { activeContract, documentIsCurrent } from "../core/facts/observation.js";
import type { ContractState, DeliverData, SnapshotId } from "../core/facts/types.js";
import { adjudicateAuditTarget } from "../git/target-placement.js";
import { observeTargetLag, contractTargetLagSchema, worktreeWorkspaceSchema } from "../git/workspace.js";
import { readManagedWorktreeAppointment, type ManagedWorktreeAppointment } from "../workspace-place.js";
import { currentVerifiedAttestation, verifyDelivery } from "./intent.js";
import { accepted, admitted } from "./outcome.js";
import { prepareDelivery } from "./deliver.js";
import type {
  DeliveryPreparationRefusal,
  DocumentDerivation,
  IntentOutcome,
  MutationOperationInput,
  RepositoryScope,
} from "./operations.js";
import { timestamp, unpackVerificationOutcome } from "./operations.js";
export const auditReportSchema = z
  .object({
    candidate: z.union([
      z.object({ kind: z.literal("blocked"), refusal: deliveryPreparationRefusalSchema }).strict(),
      z
        .object({
          kind: z.literal("ready"),
          workspace: worktreeWorkspaceSchema,
          identity: deliverDataSchema,
          scope: deliveryDiffScopeSchema,
          diff: z.string().optional(),
        })
        .strict(),
    ]),
    verification: z.union([
      z.object({ kind: z.literal("not-run") }).strict(),
      z.object({ kind: z.literal("undeclared") }).strict(),
      z.object({ kind: z.literal("stopped"), stop: verificationStopSchema }).strict(),
      z
        .object({
          kind: z.enum(["satisfied", "unsatisfied"]),
          passed: z.number(),
          total: z.number(),
          summary: z.string().optional(),
        })
        .strict(),
      verificationReuseSchema.extend({ kind: z.literal("reused") }).strict(),
    ]),
    target: z.union([z.object({ kind: z.literal("not-observed") }).strict(), auditTargetAnswerSchema]),
    targetLag: contractTargetLagSchema.optional(),
    delivery: z
      .object({
        changeId: changeIdSchema,
        relation: z.enum(["identical", "differs"]),
        verification: z.union([
          z.object({ kind: z.enum(["undeclared", "unrecorded"]) }).strict(),
          z.object({ kind: z.literal("recorded"), verdict: verdictSchema, fact: entryUlidSchema }).strict(),
        ]),
      })
      .strict()
      .optional(),
  })
  .strict();
type AuditWorkspace = z.infer<typeof worktreeWorkspaceSchema>;
export type AuditReport = z.infer<typeof auditReportSchema>;

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

function auditDeliveryRelation(
  state: ContractState,
  candidate: DeliverData,
  verificationDeclared: boolean,
): AuditReport["delivery"] {
  const recorded = state.delivery?.data.integration.changeId;
  if (recorded === undefined) return undefined;
  const verification = currentVerifiedAttestation(state);
  return {
    changeId: recorded,
    relation: recorded === candidate.integration.changeId ? "identical" : "differs",
    verification: !verificationDeclared
      ? { kind: "undeclared" }
      : verification === undefined
        ? { kind: "unrecorded" }
        : { kind: "recorded", verdict: verification.verdict, fact: verification.entry },
  };
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
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
  if (verification === null) throw new Error("audit verification preparation unexpectedly produced no attempt");
  return unpackVerificationOutcome(verification);
}

function auditVerificationAnswer(
  verified: ReturnType<typeof unpackVerificationOutcome> | undefined,
  declared: boolean,
): AuditReport["verification"] {
  if (!declared) return { kind: "undeclared" };
  if (verified === undefined) return { kind: "not-run" };
  if (verified.stop !== undefined) return { kind: "stopped", stop: verified.stop };
  if (verified.reuse !== undefined) return { kind: "reused", ...verified.reuse };
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
): IntentOutcome<AuditReport, never> {
  const obligations = {
    ...(verified?.cleanup === undefined ? {} : { cleanup: verified.cleanup }),
    ...(verified?.leak === undefined ? {} : { leak: verified.leak }),
  };
  return verified?.admission === undefined
    ? accepted(state, [], value, undefined, obligations)
    : { ...admitted(verified.admission, value), ...obligations };
}

export type AuditRefusal =
  | import("../core/verbs/deliver.js").DeliverRefusal
  | import("../verification/declaration.js").VerificationDeclarationRefusal;

// eslint-disable-next-line complexity -- one adjudicated audit retains partial observations before each later owner boundary.
export async function auditOperation(input: AuditOperationInput): Promise<IntentOutcome<AuditReport, AuditRefusal>> {
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
  const candidate = await readyAuditCandidate(input.scope, prepared.data, workspace.answer, input.showDiff === true);
  input.progress?.recordAudit(state.id, { candidate });
  const verified =
    derivation.verification.data === null
      ? undefined
      : await auditCandidateVerification(
          input,
          state,
          prepared.data.integration.snapshot,
          derivation.verification.data,
        );
  const verification = auditVerificationAnswer(verified, derivation.verification.data !== null);
  const delivery = auditDeliveryRelation(
    verified?.admission?.state ?? state,
    prepared.data,
    derivation.verification.data !== null,
  );
  input.progress?.recordAudit(state.id, { verification, ...(delivery === undefined ? {} : { delivery }) });
  const target = await auditTargetAnswer(input.scope, state, prepared.data);
  input.progress?.recordAudit(state.id, { target });
  const targetLag =
    target.kind === "placeable" ? await observeTargetLag(input.scope, workspace.answer.path, target.head) : undefined;
  const value: AuditReport = {
    candidate,
    verification,
    target,
    ...(targetLag === undefined ? {} : { targetLag }),
    ...(delivery === undefined ? {} : { delivery }),
  };
  return completedAudit(state, verified, value);
}
