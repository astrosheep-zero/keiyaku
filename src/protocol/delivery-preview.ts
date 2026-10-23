import { z } from "zod";
import {
  deliverDataSchema,
  deliveryPreparationRefusalSchema,
  changeIdSchema,
  verdictSchema,
  entryUlidSchema,
  contractIdSchema,
  gateReportSchema,
  recordedIntegrationSnapshots,
} from "./operations.js";
import { previewTargetAnswerSchema, adjudicatePreviewTarget } from "../git/target-placement.js";
import { verificationReuseSchema, currentVerifiedAttestation } from "./intent.js";
import { deliveryDiffScopeSchema, readDeliveryDiff, readDeliveryScope } from "../git/integration.js";
import { observeGitForAdmissionAt } from "../git/observe.js";
import { activeContract, documentIsCurrent } from "../core/facts/observation.js";
import { gateReports } from "../core/facts/gate.js";
import { unmetPrerequisites } from "../core/verbs/placement.js";
import type { ContractState, DeliverData } from "../core/facts/types.js";
import { observeTargetLag, contractTargetLagSchema, worktreeWorkspaceSchema } from "../git/workspace.js";
import { readManagedWorktreeAppointment } from "../workspace-place.js";
import { accepted } from "./outcome.js";
import { prepareDelivery } from "./deliver.js";
import type {
  DeliveryPreparationRefusal,
  DocumentDerivation,
  IntentOutcome,
  MutationOperationInput,
  RepositoryScope,
} from "./operations.js";

export const deliveryPreviewReportSchema = z
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
          requirements: z
            .object({
              gates: z.array(gateReportSchema).readonly(),
              unmetPrerequisites: z
                .array(
                  z
                    .object({
                      contractId: contractIdSchema,
                      state: z.enum(["missing", "active", "abandoned"]),
                    })
                    .strict(),
                )
                .readonly(),
            })
            .strict(),
        })
        .strict(),
    ]),
    verification: z.union([
      z.object({ kind: z.literal("not-run") }).strict(),
      z.object({ kind: z.literal("undeclared") }).strict(),
      z.object({ kind: z.literal("required") }).strict(),
      verificationReuseSchema.extend({ kind: z.literal("recorded") }).strict(),
    ]),
    target: z.union([z.object({ kind: z.literal("not-observed") }).strict(), previewTargetAnswerSchema]),
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
export type DeliveryPreviewReport = z.infer<typeof deliveryPreviewReportSchema>;

type DeliveryPreviewOperationInput = MutationOperationInput &
  Readonly<{
    deriveDocument: (state: ContractState) => DocumentDerivation;
    requireBranchesToBeUpToDate?: boolean;
    includeDirty?: boolean;
    showDiff?: boolean;
    signal?: AbortSignal;
  }>;

function deliveryRelation(
  state: ContractState,
  candidate: DeliverData,
  declaration: DocumentDerivation["verification"]["data"],
): DeliveryPreviewReport["delivery"] {
  const recorded = state.delivery?.data.integration.changeId;
  if (recorded === undefined) return undefined;
  const verification = declaration === null ? undefined : currentVerifiedAttestation(state);
  return {
    changeId: recorded,
    relation: recorded === candidate.integration.changeId ? "identical" : "differs",
    verification:
      declaration === null
        ? { kind: "undeclared" }
        : verification === undefined
          ? { kind: "unrecorded" }
          : { kind: "recorded", verdict: verification.verdict, fact: verification.entry },
  };
}

function verificationAnswer(
  prospective: ContractState,
  declaration: DocumentDerivation["verification"]["data"],
): DeliveryPreviewReport["verification"] {
  if (declaration === null) return { kind: "undeclared" };
  const evidence = currentVerifiedAttestation(prospective);
  return evidence === undefined ? { kind: "required" } : { kind: "recorded", ...evidence };
}

async function readyCandidate(
  repository: RepositoryScope,
  candidate: DeliverData,
  workspace: z.infer<typeof worktreeWorkspaceSchema>,
  requirements: Extract<DeliveryPreviewReport["candidate"], { kind: "ready" }>["requirements"],
  showDiff: boolean,
): Promise<Extract<DeliveryPreviewReport["candidate"], { kind: "ready" }>> {
  const { predecessor, snapshot } = candidate.integration;
  const scope = await readDeliveryScope(repository, predecessor, snapshot, showDiff);
  const diff = showDiff ? await readDeliveryDiff(repository, predecessor, snapshot) : undefined;
  return {
    kind: "ready",
    workspace,
    identity: candidate,
    scope,
    requirements,
    ...(diff === undefined || diff === null ? {} : { diff }),
  };
}

async function targetAnswer(
  repository: RepositoryScope,
  state: ContractState,
  candidate: DeliverData,
): Promise<DeliveryPreviewReport["target"]> {
  const target = state.coordinates.target;
  if (target === undefined) return { kind: "not-observed" };
  return await adjudicatePreviewTarget(repository, {
    contractId: state.id,
    coordinates: { ...state.coordinates, target },
    predecessor: candidate.integration.predecessor,
    candidate: candidate.integration.snapshot,
  });
}

function blockedPreview(refusal: DeliveryPreparationRefusal): DeliveryPreviewReport {
  return {
    candidate: { kind: "blocked", refusal },
    verification: { kind: "not-run" },
    target: { kind: "not-observed" },
  };
}

type PreviewRefusal =
  | import("../core/verbs/deliver.js").DeliverRefusal
  | import("../verification/declaration.js").VerificationDeclarationRefusal;

export async function previewDeliveryOperation(
  input: DeliveryPreviewOperationInput,
): Promise<IntentOutcome<DeliveryPreviewReport, PreviewRefusal>> {
  input.signal?.throwIfAborted();
  const observed = await observeGitForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = activeContract(observed.decision, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  const derivation = input.deriveDocument(state);
  if (!documentIsCurrent(state, derivation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved", contractId: input.contractId } };
  }
  if (derivation.verification.kind === "refused") return { kind: "refused", refusal: derivation.verification.refusal };
  const appointment = await readManagedWorktreeAppointment(input.scope, state.id);
  if (appointment.kind === "failed") throw new Error(appointment.diagnostic);
  if (appointment.kind === "unappointed") {
    return accepted(state, [], blockedPreview({ kind: "worktree-missing", contractId: state.id }));
  }
  const prepared = await prepareDelivery(
    input.scope,
    {
      contractId: state.id,
      coordinates: state.coordinates,
      recordedIntegrations: recordedIntegrationSnapshots(observed.journals.get(state.id)?.entries ?? []),
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
  if (prepared.kind === "refused") return accepted(state, [], blockedPreview(prepared.refusal));
  // Supply prospective keys to the generic currentness owner, never a fabricated delivery fact.
  const prospective = { ...state, currentIntegration: prepared.data.integration };
  const candidate = await readyCandidate(
    input.scope,
    prepared.data,
    { kind: "worktree", path: appointment.path },
    {
      gates: gateReports(prospective).reports,
      unmetPrerequisites: unmetPrerequisites(state.terms.after, observed.decision),
    },
    input.showDiff === true,
  );
  input.progress?.recordDeliveryPreview(state.id, { candidate });
  const verification = verificationAnswer(prospective, derivation.verification.data);
  const delivery = deliveryRelation(state, prepared.data, derivation.verification.data);
  input.progress?.recordDeliveryPreview(state.id, { verification, ...(delivery === undefined ? {} : { delivery }) });
  const target = await targetAnswer(input.scope, state, prepared.data);
  input.progress?.recordDeliveryPreview(state.id, { target });
  const targetLag =
    target.kind === "placeable" ? await observeTargetLag(input.scope, appointment.path, target.head) : undefined;
  const value: DeliveryPreviewReport = {
    candidate,
    verification,
    target,
    ...(targetLag === undefined ? {} : { targetLag }),
    ...(delivery === undefined ? {} : { delivery }),
  };
  return accepted(state, [], value);
}
