import { worktreeChangeId } from "../git/integration.js";
import {
  captureTender,
  dirtyTenderDelta,
  dirtyTenderRefusal,
  type TenderCapture,
  type WorkspaceDirtyDelta,
} from "../git/tender.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import { type PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import {
  matchingPrivateRootObservation,
  privateStateSeatAttempt,
  sameSpeculativeWorktreeInput,
  type SpeculativeWorktreeInput,
} from "./run.js";
import { dependencyKeySet } from "../core/subject.js";
import { contractState } from "../core/facts/observation.js";
import type { AttestationData, ContractState, DeliverData } from "../core/facts/types.js";
import { gate } from "../core/facts/types.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import { completeCandidate, type CompletionEvidence } from "./completion.js";
import { completeLeadingAdmission, contractCheckpoint } from "./progress.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import type { AttemptContext } from "../core/decide.js";
import type {
  AttemptDecision,
  DocumentDerivation,
  IntentOutcome,
  MutationOperationInput,
  RepositoryScope,
} from "./operations.js";
import { attemptDecisionWithSeatClose, timestamp } from "./operations.js";

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
export { decodeReviewValue } from "./result-codec.js";
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

type SpeculativeReview = Readonly<{
  observation: GitDecisionObservation;
  preparation?: AttestationInput<ReviewRefusal>["preparation"];
  workspace?: WorkspaceDirtyDelta;
  tender?: TenderCapture;
  worktree?: SpeculativeWorktreeInput;
}>;

function preparedReviewCapture(
  input: ReviewOperationInput,
  state: ContractState,
  prepared: Extract<Awaited<ReturnType<typeof captureReviewableWorktree>>, { kind: "prepared" }>,
): SpeculativeReview["preparation"] {
  return {
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
}

function reviewWorktreeInput(
  prepared: Extract<Awaited<ReturnType<typeof captureReviewableWorktree>>, { kind: "prepared" }>,
): SpeculativeWorktreeInput {
  return {
    tree: prepared.data.tender.tree,
    head: prepared.data.tender.head,
    ...(prepared.data.tender.mergeHead === undefined ? {} : { mergeHead: prepared.data.tender.mergeHead }),
    dirty: prepared.data.tender.dirty,
    changeId: prepared.data.changeId,
  };
}

async function recaptureReviewWorktree(
  input: ReviewOperationInput,
  state: ContractState,
): Promise<SpeculativeWorktreeInput | undefined> {
  const prepared = await captureReviewableWorktree(input.scope, {
    contractId: state.id,
    coordinates: state.coordinates,
  });
  return prepared.kind === "prepared" ? reviewWorktreeInput(prepared) : undefined;
}

async function speculateReview(input: ReviewOperationInput): Promise<SpeculativeReview> {
  const observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(observation.decision, input.contractId);
  if (state === null) return { observation };
  const prepared = await captureReviewableWorktree(input.scope, {
    contractId: state.id,
    coordinates: state.coordinates,
  });
  if (prepared.kind === "refused") {
    return { observation, preparation: { kind: "refused", refusal: prepared.refusal } };
  }
  return {
    observation,
    preparation: preparedReviewCapture(input, state, prepared),
    ...(prepared.data.workspace === undefined ? {} : { workspace: prepared.data.workspace }),
    tender: prepared.data.tender,
    worktree: reviewWorktreeInput(prepared),
  };
}

async function decideAndAdmitReview(
  input: ReviewOperationInput,
  attempt: AttemptContext,
  seat: PrivateStatePublicationSeat,
  observation: GitDecisionObservation,
  speculated: SpeculativeReview,
): Promise<AttemptDecision<PreparedReview, ReviewRefusal>> {
  const decision = decideAttestation({
    input: {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      ...(speculated.preparation === undefined ? {} : { preparation: speculated.preparation }),
    },
    attempt,
    observation: observation.decision,
  });
  if (decision.kind === "refused") return { kind: "refused", refusal: decision.refusal };
  const admission = await admitDecidedOffer({
    channel: input.channel,
    repository: input.scope,
    seat,
    decisionObservation: observation,
    attempt,
    offer: decision.offer,
    primaryContract: input.contractId,
  });
  if (admission.kind !== "accepted") return admission;
  return {
    ...admission,
    value: {
      ...(speculated.workspace === undefined ? {} : { workspace: speculated.workspace }),
      ...(speculated.tender === undefined ? {} : { tender: speculated.tender }),
    },
  };
}

async function reviewAttemptInPrivateStateSeat(
  input: ReviewOperationInput,
  attempt: AttemptContext,
  seat: PrivateStatePublicationSeat,
  speculated: SpeculativeReview,
): Promise<AttemptDecision<PreparedReview, ReviewRefusal>> {
  const observation = await matchingPrivateRootObservation(
    input.scope,
    input.channel,
    input.contractId,
    speculated.observation,
    async (fresh) => {
      if (speculated.worktree === undefined) return true;
      const state = contractState(fresh.decision, input.contractId);
      if (state === null) return false;
      return sameSpeculativeWorktreeInput(speculated.worktree, await recaptureReviewWorktree(input, state));
    },
  );
  return "kind" in observation
    ? observation
    : await decideAndAdmitReview(input, attempt, seat, observation, speculated);
}

async function reviewAttempt(
  input: ReviewOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<PreparedReview, ReviewRefusal>> {
  const speculated = await speculateReview(input);
  return await privateStateSeatAttempt(
    input.scope,
    async (seat) => await reviewAttemptInPrivateStateSeat(input, attempt, seat, speculated),
    attemptDecisionWithSeatClose,
  );
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
    checkpoint: contractCheckpoint(review),
    verifyInitial: false,
  });
  return admitted(completeLeadingAdmission(review, completed.progress), reviewValue(review.value, completed.evidence));
}
