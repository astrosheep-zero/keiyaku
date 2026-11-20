import { z } from "zod";
import { worktreeChangeId } from "../git/integration.js";
import { captureTender, type TenderCapture } from "../git/tender.js";
import { observeContractsAt } from "../git/observe.js";
import { dependencyKeySet } from "../core/subject.js";
import { contractState, type ActiveContractRefusal } from "../core/facts/observation.js";
import { gate, type AttestationData, type ContractHead, type ContractState } from "../core/facts/types.js";
import { singletonRequirement } from "../verification/declaration.js";
import { decideAttestation, type AttestationInput } from "../core/verbs/attestation.js";
import { admitIntent } from "./intent.js";
import { mintAttempts, type AcceptedAdmission } from "./attempt.js";
import { runBoundedAttempts, spentPreparation } from "./run.js";
import type { LeadingOutcome } from "./outcome.js";
import { readPlaceRegister } from "../workspace-place.js";
import { timestamp, type MutationOperationInput } from "./operations.js";

const REVIEWED = gate("reviewed");
type ReviewPreparationRefusal =
  | Readonly<{ kind: "worktree-missing" }>
  | Readonly<{ kind: "dirty-submodules"; paths: readonly string[] }>;
type ReviewRefusal = ActiveContractRefusal | ReviewPreparationRefusal;
type ReviewOperationInput = MutationOperationInput &
  Readonly<{
    verdict: AttestationData["verdict"];
    summary?: string;
  }>;
const changedPaths = z.array(z.string()).min(1).readonly();
export const reviewAdmissionValueSchema = z
  .strictObject({
    worktreeChanges: z
      .strictObject({
        staged: changedPaths.exactOptional(),
        unstaged: changedPaths.exactOptional(),
        untracked: changedPaths.exactOptional(),
        unmergedPaths: changedPaths.exactOptional(),
      })
      .readonly()
      .exactOptional(),
  })
  .readonly();
export type ReviewAdmissionValue = z.output<typeof reviewAdmissionValueSchema>;

type ReviewCapture =
  | Readonly<{ kind: "captured"; tender: TenderCapture }>
  | Readonly<{ kind: "refused"; refusal: ReviewPreparationRefusal }>;

type PreparedReview = Readonly<{
  expectedHead: ContractHead | null;
  preparation?: AttestationInput<ReviewPreparationRefusal>["preparation"];
  value?: ReviewAdmissionValue;
}>;

/**
 * Capture the invocation's immutable worktree bytes once, outside custody. Later fresh attempts
 * reuse this exact capture and never recapture the mutable worktree.
 */
async function captureReviewInvocation(input: ReviewOperationInput, state: ContractState): Promise<ReviewCapture> {
  const { scope, contractId } = input;
  const stage = { contractId, coordinates: state.coordinates };
  const place =
    state.coordinates.workspace === "worktree" ? (await readPlaceRegister(scope)).get(contractId) : undefined;
  const tender = await captureTender(scope, { ...stage, ...(place === undefined ? {} : { place }) });
  if (tender.kind === "refused") return tender;
  const { submodules } = tender.data.changes;
  if (submodules.length > 0) {
    return { kind: "refused", refusal: { kind: "dirty-submodules", paths: submodules } };
  }
  return { kind: "captured", tender: tender.data };
}

function reviewValue(tender: TenderCapture): ReviewAdmissionValue {
  const {
    changes: { staged, unstaged, untracked },
    unmergedPaths,
  } = tender;
  const worktreeChanges = {
    ...(staged.length === 0 ? {} : { staged }),
    ...(unstaged.length === 0 ? {} : { unstaged }),
    ...(untracked.length === 0 ? {} : { untracked }),
    ...(unmergedPaths.length === 0 ? {} : { unmergedPaths }),
  };
  return staged.length + unstaged.length + untracked.length + unmergedPaths.length === 0 ? {} : { worktreeChanges };
}

/** Derive one attempt's testimony from the immutable capture and fresh Contract authority. */
async function prepareReviewAttempt(
  input: ReviewOperationInput,
  state: ContractState,
  capture: TenderCapture,
): Promise<{ preparation: AttestationInput<ReviewPreparationRefusal>["preparation"]; value: ReviewAdmissionValue }> {
  const { scope, contractId } = input;
  const stage = { contractId, coordinates: state.coordinates };
  return {
    preparation: {
      kind: "prepared",
      data: {
        gate: REVIEWED,
        requirement: singletonRequirement(REVIEWED),
        subject: dependencyKeySet([
          { kind: "document", value: state.terms.document.key },
          { kind: "change", value: await worktreeChangeId(scope, stage, capture) },
        ]),
        verdict: input.verdict,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      },
    },
    value: reviewValue(capture),
  };
}

export async function admitReviewOperation(
  input: ReviewOperationInput,
): Promise<LeadingOutcome<ReviewAdmissionValue, ReviewRefusal>> {
  const { scope, channel, contractId, progress } = input;
  const initial = await observeContractsAt(scope, channel, [contractId]);
  const initialState = contractState(initial.decision, contractId);
  const capture =
    initialState === null || initialState.terminal !== null
      ? undefined
      : await captureReviewInvocation(input, initialState);
  const result = await runBoundedAttempts<
    PreparedReview,
    AcceptedAdmission & Readonly<{ value: ReviewAdmissionValue }>,
    ReviewRefusal
  >(
    mintAttempts({ entryCount: 1 }),
    async () => {
      const before = await observeContractsAt(scope, channel, [contractId]);
      const state = contractState(before.decision, contractId);
      if (state === null || state.terminal !== null) {
        return { kind: "prepared", prepared: { expectedHead: state?.head ?? null } };
      }
      if (capture === undefined) return spentPreparation;
      if (capture.kind === "refused") {
        return {
          kind: "prepared",
          prepared: {
            expectedHead: state.head,
            preparation: { kind: "refused", refusal: capture.refusal },
            value: {},
          },
        };
      }
      const prepared = await prepareReviewAttempt(input, state, capture.tender);
      return {
        kind: "prepared",
        prepared: { expectedHead: state.head, preparation: prepared.preparation, value: prepared.value },
      };
    },
    async (prepared, attempt) => {
      const admitted = await admitIntent(
        channel,
        scope,
        {
          contractId,
          at: timestamp(),
          ...(prepared.preparation === undefined ? {} : { preparation: prepared.preparation }),
        },
        decideAttestation<ReviewPreparationRefusal>,
        { attempt, expectedHead: prepared.expectedHead, ...(progress === undefined ? {} : { progress }) },
      );
      return admitted.kind === "accepted" ? { ...admitted, value: prepared.value ?? {} } : admitted;
    },
  );
  if (result.kind === "accepted") {
    progress?.recordResidue(contractId, result);
    return result;
  }
  if (result.kind === "refused") return result;
  return { kind: "retry", reason: result };
}
