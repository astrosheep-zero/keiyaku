import { z } from "zod";
import { changeIdSchema, contractIdSchema, snapshotIdSchema } from "./operations.js";
import {
  preparationReasonSchema,
  checkoutCollisionSchema,
  targetWorkspaceReasonSchema,
  compactReason,
  compactPreparationReason,
} from "./result-reasons.js";
import { previewTargetAnswerSchema, adjudicatePreviewTarget } from "../git/target-placement.js";
import { readDeliveryDiff, readDeliveryScope } from "../git/integration.js";
import { observeGitForAdmissionAt } from "../git/observe.js";
import { activeContract, targetContractRefusal } from "../core/facts/observation.js";
import { gateReports } from "../core/facts/gate.js";
import { unmetPrerequisites } from "../core/verbs/placement.js";
import type { ContractState, DeliverData } from "../core/facts/types.js";
import { observeTargetLag, contractTargetLagSchema } from "../git/workspace.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import { accepted } from "./outcome.js";
import { deliveryIntegrationSnapshots, prepareDelivery } from "./deliver.js";
import { compactScope, compactScopeSchema, requirementProblemSchema, unmetGateProblems } from "./completion.js";
import type {
  DocumentDerivation,
  IntentOutcome,
  MechanicalPreparationRefusal,
  MutationOperationInput,
  RepositoryScope,
} from "./operations.js";

const rawTargetOptions = previewTargetAnswerSchema.options;
const placeableTargetSchema = z
  .strictObject({
    kind: z.literal("placeable"),
    ref: z.string().min(1),
    head: snapshotIdSchema,
    behind: z.union([z.number().int().positive(), z.literal("unknown")]).exactOptional(),
    checkouts: z
      .array(z.strictObject({ path: z.string().min(1), diagnostic: z.string().min(1) }).readonly())
      .min(1)
      .readonly()
      .exactOptional(),
  })
  .readonly();
const refusedTargetSchema = z
  .strictObject({
    kind: z.literal("refused"),
    reason: z.union([checkoutCollisionSchema, targetWorkspaceReasonSchema]),
  })
  .readonly();
const targetSchema = z.union([placeableTargetSchema, rawTargetOptions[1], refusedTargetSchema, rawTargetOptions[3]]);
const readySchema = z
  .strictObject({
    kind: z.literal("ready"),
    contractId: contractIdSchema,
    candidate: snapshotIdSchema,
    integration: snapshotIdSchema,
    contentId: changeIdSchema,
    scope: compactScopeSchema,
    diff: z
      .union([
        z.strictObject({ kind: z.literal("present"), text: z.string() }).readonly(),
        z.strictObject({ kind: z.literal("unavailable") }).readonly(),
      ])
      .exactOptional(),
    unmetGates: z.array(requirementProblemSchema).min(1).readonly().exactOptional(),
    unmetPrerequisites: z
      .array(
        z.strictObject({ contractId: contractIdSchema, state: z.enum(["missing", "active", "abandoned"]) }).readonly(),
      )
      .min(1)
      .readonly()
      .exactOptional(),
    target: targetSchema.exactOptional(),
    previousContentId: changeIdSchema.exactOptional(),
  })
  .readonly();
export const deliveryPreviewReportSchema = z.union([
  readySchema,
  z
    .strictObject({
      kind: z.literal("blocked"),
      contractId: contractIdSchema,
      reason: preparationReasonSchema,
    })
    .readonly(),
]);
export type DeliveryPreviewReport = z.output<typeof deliveryPreviewReportSchema>;
type ReadyPreview = Extract<DeliveryPreviewReport, { kind: "ready" }>;
type DeliveryPreviewOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument: (state: ContractState) => DocumentDerivation;
    requireBranchesToBeUpToDate?: boolean;
    includeDirty?: boolean;
    showDiff?: boolean;
    signal?: AbortSignal;
  }>;

function deliveryRelation(state: ContractState, candidate: DeliverData): ReadyPreview["previousContentId"] {
  const contentId = state.delivery?.data.integration.changeId;
  return contentId === undefined || contentId === candidate.integration.changeId ? undefined : contentId;
}

async function targetAnswer(
  repository: RepositoryScope,
  state: ContractState,
  candidate: DeliverData,
): Promise<ReadyPreview["target"]> {
  const target = state.coordinates.target;
  if (target === undefined) return undefined;
  const answer = await adjudicatePreviewTarget(repository, {
    contractId: state.id,
    coordinates: { ...state.coordinates, target },
    predecessor: candidate.integration.predecessor,
    candidate: candidate.integration.snapshot,
  });
  if (answer.kind === "refused") return { kind: "refused", reason: compactReason(answer.refusal) };
  if (answer.kind !== "placeable") return answer;
  const checkouts = answer.checkouts
    .filter((checkout) => checkout.kind === "not-followable")
    .map(({ path, diagnostic }) => ({ path, diagnostic }));
  return { kind: "placeable", ref: answer.ref, head: answer.head, ...(checkouts.length === 0 ? {} : { checkouts }) };
}

function blockedPreview(contractId: ContractState["id"], reason: MechanicalPreparationRefusal): DeliveryPreviewReport {
  return { kind: "blocked", contractId, reason: compactPreparationReason(reason) };
}
type PreviewRefusal =
  | Exclude<import("../core/verbs/deliver.js").DeliverRefusal, { kind: "document-moved" }>
  | import("../verification/declaration.js").VerificationDeclarationRefusal;

function compactTargetLag(
  lag: z.output<typeof contractTargetLagSchema> | undefined,
): Extract<NonNullable<ReadyPreview["target"]>, { kind: "placeable" }>["behind"] {
  if (lag === undefined || lag.kind === "none" || (lag.kind === "counted" && lag.behind === 0)) return undefined;
  return lag.kind === "unknown" ? "unknown" : lag.behind;
}

async function observeReadyPreview(
  input: DeliveryPreviewOperationInput,
  observed: Readonly<{
    state: ContractState;
    candidate: DeliverData;
    workspacePath: string;
    decision: Parameters<typeof unmetPrerequisites>[1];
  }>,
): Promise<ReadyPreview> {
  const { state, candidate, workspacePath, decision } = observed;
  const identity = {
    kind: "ready" as const,
    contractId: state.id,
    candidate: candidate.tenderSnapshot,
    integration: candidate.integration.snapshot,
    contentId: candidate.integration.changeId,
  };
  input.progress?.recordDeliveryPreview(state.id, identity);
  const prospective = { ...state, currentIntegration: candidate.integration };
  const unmetGates = unmetGateProblems(gateReports(prospective).reports);
  const prerequisites = unmetPrerequisites(state.terms.after, decision);
  const previousContentId = deliveryRelation(state, candidate);
  const requirements = {
    ...(unmetGates.length === 0 ? {} : { unmetGates }),
    ...(prerequisites.length === 0 ? {} : { unmetPrerequisites: prerequisites }),
    ...(previousContentId === undefined ? {} : { previousContentId }),
  };
  input.progress?.recordDeliveryPreview(state.id, requirements);
  const scope = compactScope(
    await readDeliveryScope(
      input.scope,
      candidate.integration.predecessor,
      candidate.integration.snapshot,
      input.showDiff === true,
    ),
  );
  input.progress?.recordDeliveryPreview(state.id, { scope });
  const diff =
    input.showDiff === true
      ? await readDeliveryDiff(input.scope, candidate.integration.predecessor, candidate.integration.snapshot)
      : undefined;
  const detail =
    diff === undefined
      ? {}
      : { diff: diff === null ? { kind: "unavailable" as const } : { kind: "present" as const, text: diff } };
  input.progress?.recordDeliveryPreview(state.id, detail);
  const target = await targetAnswer(input.scope, state, candidate);
  if (target !== undefined) input.progress?.recordDeliveryPreview(state.id, { target });
  const lag =
    target?.kind === "placeable" ? await observeTargetLag(input.scope, workspacePath, target.head) : undefined;
  const targetLag = compactTargetLag(lag);
  return {
    ...identity,
    scope,
    ...requirements,
    ...detail,
    ...(target === undefined
      ? {}
      : { target: target.kind === "placeable" && targetLag !== undefined ? { ...target, behind: targetLag } : target }),
  };
}

/** A native read answer, never an admission or an invitation to run Verification. */
export async function previewDeliveryOperation(
  input: DeliveryPreviewOperationInput,
): Promise<Exclude<IntentOutcome<DeliveryPreviewReport, PreviewRefusal>, { kind: "retry" }>> {
  input.signal?.throwIfAborted();
  const observed = await observeGitForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = activeContract(observed.decision, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  const targetRefusal = targetContractRefusal(observed.decision, state.coordinates.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  const derivation = input.deriveDocument(state);
  if (derivation.verification.kind === "refused") return { kind: "refused", refusal: derivation.verification.refusal };
  const appointment = await readManagedWorktreeAppointment(input.scope, state.id);
  if (appointment.kind === "failed") throw new Error(appointment.diagnostic);
  if (appointment.kind === "unappointed")
    return accepted(state, [], blockedPreview(state.id, { kind: "worktree-missing" }));
  const prepared = await prepareDelivery(
    input.scope,
    {
      contractId: state.id,
      coordinates: state.coordinates,
      recordedIntegrations: deliveryIntegrationSnapshots(observed.journals.get(state.id)?.entries ?? []),
      appointment,
    },
    {
      title: derivation.title,
      document: derivation.bytes,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      requireBranchesToBeUpToDate: input.requireBranchesToBeUpToDate ?? false,
      includeDirty: input.includeDirty ?? false,
    },
  );
  if (prepared.kind === "refused") return accepted(state, [], blockedPreview(state.id, prepared.refusal));
  return accepted(
    state,
    [],
    await observeReadyPreview(input, {
      state,
      candidate: prepared.data,
      workspacePath: appointment.path,
      decision: observed.decision,
    }),
  );
}
