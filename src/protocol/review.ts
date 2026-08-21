import { worktreeChangeId } from "../git/integration.js";
import {
  captureTender,
  dirtyTenderDelta,
  dirtyTenderRefusal,
  type TenderCapture,
  type WorkspaceDirtyDelta,
} from "../git/tender.js";
import { observeContractsForAdmissionAt } from "../git/observe.js";
import { dependencyKeySet } from "../core/subject.js";
import { contractState } from "../core/facts/observation.js";
import type { AttestationData, ContractState, DeliverData } from "../core/facts/types.js";
import { gate } from "../core/facts/types.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import { completeCandidate, type CompletionEvidence } from "./completion.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import type { AttemptContext } from "../core/decide.js";
import type {
  AttemptDecision,
  DocumentDerivation,
  IntentOutcome,
  MutationOperationInput,
  RepositoryScope,
} from "./operations.js";
import { timestamp } from "./operations.js";

const REVIEWED = gate("reviewed");
type ReviewPreparationRefusal =
  | Readonly<{
      kind: "worktree-missing";
      contractId: import("../core/facts/types.js").ContractId;
    }>
  | import("../git/tender.js").DirtyWorkspaceRefusal;
type ReviewRefusal = AttestationRefusal | ReviewPreparationRefusal;
type ReviewOperationInput = MutationOperationInput &
  Readonly<{
    verdict: AttestationData["verdict"];
    summary?: string;
    deriveDocument?: (state: ContractState) => DocumentDerivation;
  }>;
export type ReviewValue = CompletionEvidence & Readonly<{ workspace?: WorkspaceDirtyDelta }>;
type PreparedReview = Readonly<{
  workspace?: WorkspaceDirtyDelta;
  tender?: TenderCapture;
}>;

async function captureReviewableWorktree(
  repository: RepositoryScope,
  stage: Readonly<{
    contractId: import("../core/facts/types.js").ContractId;
    coordinates: ContractState["coordinates"];
  }>,
): Promise<
  | {
      kind: "prepared";
      data: Readonly<{
        changeId: DeliverData["integration"]["changeId"];
        tender: TenderCapture;
        workspace?: WorkspaceDirtyDelta;
      }>;
    }
  | { kind: "refused"; refusal: ReviewPreparationRefusal }
> {
  const appointed =
    stage.coordinates.workspace === "worktree"
      ? appointmentFor(await readPlaceRegister(repository), stage.contractId)
      : undefined;
  const tender = await captureTender(repository, {
    ...stage,
    ...(appointed === undefined ? {} : { place: appointed.place }),
  });
  if (tender.kind === "refused") return tender;
  if (tender.data.changes.submodules.length > 0) {
    return { kind: "refused", refusal: await dirtyTenderRefusal(repository, stage.contractId, tender.data) };
  }
  const workspace = await dirtyTenderDelta(repository, tender.data);
  return {
    kind: "prepared",
    data: {
      changeId: await worktreeChangeId(repository, stage, tender.data),
      tender: tender.data,
      ...(workspace === undefined ? {} : { workspace }),
    },
  };
}

export async function prepareReview(
  repository: RepositoryScope,
  stage: Readonly<{
    contractId: import("../core/facts/types.js").ContractId;
    coordinates: ContractState["coordinates"];
  }>,
): Promise<
  | {
      kind: "prepared";
      data: Readonly<{
        changeId: DeliverData["integration"]["changeId"];
        workspace?: WorkspaceDirtyDelta;
      }>;
    }
  | { kind: "refused"; refusal: ReviewPreparationRefusal }
> {
  const prepared = await captureReviewableWorktree(repository, stage);
  if (prepared.kind === "refused") return prepared;
  return {
    kind: "prepared",
    data: {
      changeId: prepared.data.changeId,
      ...(prepared.data.workspace === undefined ? {} : { workspace: prepared.data.workspace }),
    },
  };
}

function reviewValue(value: PreparedReview, completion: CompletionEvidence = {}): ReviewValue {
  return {
    ...(value.workspace === undefined ? {} : { workspace: value.workspace }),
    ...completion,
  };
}

async function reviewAttempt(
  input: ReviewOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<PreparedReview, ReviewRefusal>> {
  const decisionObservation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(decisionObservation.decision, input.contractId);
  let preparation: AttestationInput<ReviewRefusal>["preparation"];
  let workspace: WorkspaceDirtyDelta | undefined;
  let tender: TenderCapture | undefined;
  if (state !== null) {
    const prepared = await captureReviewableWorktree(input.scope, {
      contractId: state.id,
      coordinates: state.coordinates,
    });
    preparation =
      prepared.kind === "refused"
        ? { kind: "refused", refusal: prepared.refusal }
        : {
            kind: "prepared",
            data: {
              gate: REVIEWED,
              subject: dependencyKeySet([
                { kind: "document", value: state.terms.document.key },
                { kind: "change", value: prepared.data.changeId },
              ]),
              verdict: input.verdict,
              ...(input.summary === undefined ? {} : { summary: input.summary }),
            },
          };
    if (prepared.kind === "prepared") {
      workspace = prepared.data.workspace;
      tender = prepared.data.tender;
    }
  }
  const decision = decideAttestation({
    input: {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      ...(preparation === undefined ? {} : { preparation }),
    },
    attempt,
    observation: decisionObservation.decision,
  });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  const admission = await admitDecidedOffer({
    channel: input.channel,
    repository: input.scope,
    decisionObservation,
    attempt,
    offer: decision.offer,
    primaryContract: input.contractId,
  });
  if (admission.kind === "accepted")
    return {
      ...admission,
      value: {
        ...(workspace === undefined ? {} : { workspace }),
        ...(tender === undefined ? {} : { tender }),
      },
    };
  return admission;
}

export async function reviewOperation(input: ReviewOperationInput): Promise<IntentOutcome<ReviewValue, ReviewRefusal>> {
  const git = input.scope;
  const attempts = mintAttempts({ entryCount: 1 });
  let review: Extract<AttemptDecision<PreparedReview, ReviewRefusal>, { kind: "accepted" | "refused" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = await reviewAttempt(input, attempts[index]!);
    if (result.kind === "accepted" || result.kind === "refused") {
      review = result;
      break;
    }
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
  }
  if (review === null) return { kind: "retry", reason: { kind: "exhausted" } };
  if (review.kind !== "accepted") return review;
  if (input.verdict !== "satisfied") return admitted(review, reviewValue(review.value));
  const derivation = input.deriveDocument?.(review.state);
  const completed = await completeCandidate({
    channel: input.channel,
    repository: git,
    contractId: input.contractId,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(review.state.coordinates.target === undefined ? {} : { target: review.state.coordinates.target }),
    verification: derivation?.verification ?? { kind: "prepared", data: null },
    initial: review,
    verifyInitial: false,
  });
  return admitted(completed.admission, reviewValue(review.value, completed.evidence));
}
