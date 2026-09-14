import { worktreeChangeId } from "../git/integration.js";
import {
  captureTender,
  dirtyTenderDelta,
  dirtyTenderRefusal,
  type TenderCapture,
  type WorkspaceDirtyDelta,
} from "../git/tender.js";
import { observeContractsForAdmissionAt, type GitDecisionObservation } from "../git/observe.js";
import { unmergedWorkspacePaths, worktreePath } from "../git/workspace.js";
import { type PrivateStatePublicationSeat } from "../git/private-state-seat.js";
import {
  contractStateWitness,
  privateStateSeatAttempt,
  sameWorktreeWitness,
  STALE_PRIVATE_STATE_PREPARATION,
  type ContractStateWitness,
  type WorktreeWitness,
} from "./run.js";
import { dependencyKeySet } from "../core/subject.js";
import { contractState } from "../core/facts/observation.js";
import type { AttestationData, ContractState, DeliverData } from "../core/facts/types.js";
import { gate } from "../core/facts/types.js";
import { decideAttestation, type AttestationInput, type AttestationRefusal } from "../core/verbs/attestation.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import type { LeadingOutcome } from "./outcome.js";
import type { CompletionEvidence } from "./completion.js";
import { appointmentFor, readPlaceRegister } from "../workspace-place.js";
import type { AttemptContext } from "../core/decide.js";
import type { AttemptDecision, MutationOperationInput, RepositoryScope } from "./operations.js";
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
  }>;
export type ReviewWorkspaceEvidence = WorkspaceDirtyDelta & Readonly<{ unmergedPaths: readonly string[] }>;
export type ReviewAdmissionValue = Readonly<{ workspace?: ReviewWorkspaceEvidence }>;
export type ReviewValue = CompletionEvidence & ReviewAdmissionValue;
export { decodeReviewValue } from "./result-codec.js";
type PreparedReview = Readonly<{
  workspace?: ReviewWorkspaceEvidence;
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
        workspace?: ReviewWorkspaceEvidence;
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
  const workspacePath = appointed === undefined ? undefined : worktreePath(repository, appointed.place);
  const unmergedPaths = workspacePath === undefined ? [] : await unmergedWorkspacePaths(repository, workspacePath);
  const workspaceEvidence =
    workspace === undefined && unmergedPaths.length === 0
      ? undefined
      : {
          staged: workspace?.staged ?? [],
          unstaged: workspace?.unstaged ?? [],
          untracked: workspace?.untracked ?? [],
          shortStat: workspace?.shortStat ?? { filesChanged: 0, insertions: 0, deletions: 0 },
          unmergedPaths,
        };
  return {
    kind: "prepared",
    data: {
      changeId: await worktreeChangeId(repository, stage, tender.data),
      tender: tender.data,
      ...(workspaceEvidence === undefined ? {} : { workspace: workspaceEvidence }),
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
        workspace?: ReviewWorkspaceEvidence;
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

/**
 * Physical review work prepared outside custody. The reviewable subject is recomputed from the fresh
 * in-custody Contract, and the captured worktree stays usable only while its witness still holds.
 */
type ReviewArtifacts =
  | Readonly<{ kind: "refused"; refusal: ReviewPreparationRefusal }>
  | Readonly<{ kind: "captured"; workspace?: ReviewWorkspaceEvidence; worktree: WorktreeWitness }>;

type ExternalReviewPreparation =
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "artifacts"; witness: ContractStateWitness; artifacts: ReviewArtifacts }>;

type AssembledReview =
  | Readonly<{ kind: "stale" }>
  | Readonly<{
      kind: "assembled";
      preparation?: AttestationInput<ReviewRefusal>["preparation"];
      workspace?: ReviewWorkspaceEvidence;
    }>;

function preparedReviewCapture(
  input: ReviewOperationInput,
  state: ContractState,
  changeId: DeliverData["integration"]["changeId"],
): AttestationInput<ReviewRefusal>["preparation"] {
  return {
    kind: "prepared",
    data: {
      gate: REVIEWED,
      subject: dependencyKeySet([
        { kind: "document", value: state.terms.document.key },
        { kind: "change", value: changeId },
      ]),
      verdict: input.verdict,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    },
  };
}

function reviewWorktreeInput(
  prepared: Extract<Awaited<ReturnType<typeof captureReviewableWorktree>>, { kind: "prepared" }>,
): WorktreeWitness {
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
): Promise<WorktreeWitness | undefined> {
  const prepared = await captureReviewableWorktree(input.scope, {
    contractId: state.id,
    coordinates: state.coordinates,
  });
  return prepared.kind === "prepared" ? reviewWorktreeInput(prepared) : undefined;
}

/** Capture the reviewable worktree from one non-authoritative private-state read. */
async function prepareExternalReview(input: ReviewOperationInput): Promise<ExternalReviewPreparation> {
  const observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
  const state = contractState(observation.decision, input.contractId);
  if (state === null) return { kind: "unavailable" };
  const prepared = await captureReviewableWorktree(input.scope, {
    contractId: state.id,
    coordinates: state.coordinates,
  });
  return {
    kind: "artifacts",
    witness: contractStateWitness(state),
    artifacts:
      prepared.kind === "refused"
        ? { kind: "refused", refusal: prepared.refusal }
        : {
            kind: "captured",
            ...(prepared.data.workspace === undefined ? {} : { workspace: prepared.data.workspace }),
            worktree: reviewWorktreeInput(prepared),
          },
  };
}

/** Assemble the in-custody attestation input from the fresh Contract and validated artifacts. */
async function assembleReviewAttempt(
  input: ReviewOperationInput,
  observation: GitDecisionObservation,
  external: ExternalReviewPreparation,
): Promise<AssembledReview> {
  const state = contractState(observation.decision, input.contractId);
  if (external.kind === "unavailable") return state === null ? { kind: "assembled" } : { kind: "stale" };
  if (state === null) return { kind: "stale" };
  if (external.witness.head !== state.head) return { kind: "stale" };
  if (external.artifacts.kind === "refused") {
    return { kind: "assembled", preparation: { kind: "refused", refusal: external.artifacts.refusal } };
  }
  if (!sameWorktreeWitness(external.artifacts.worktree, await recaptureReviewWorktree(input, state))) {
    return { kind: "stale" };
  }
  return {
    kind: "assembled",
    preparation: preparedReviewCapture(input, state, external.artifacts.worktree.changeId),
    ...(external.artifacts.workspace === undefined ? {} : { workspace: external.artifacts.workspace }),
  };
}

async function decideAndAdmitReview(
  input: ReviewOperationInput,
  attempt: AttemptContext,
  seat: PrivateStatePublicationSeat,
  observation: GitDecisionObservation,
  assembled: Extract<AssembledReview, { kind: "assembled" }>,
): Promise<AttemptDecision<PreparedReview, ReviewRefusal>> {
  const decision = decideAttestation({
    input: {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      ...(assembled.preparation === undefined ? {} : { preparation: assembled.preparation }),
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
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
  if (admission.kind !== "accepted") return admission;
  return {
    ...admission,
    value: {
      ...(assembled.workspace === undefined ? {} : { workspace: assembled.workspace }),
    },
  };
}

/**
 * One review attempt: the repeatable worktree capture happens outside custody, then a single
 * in-custody observation, witness validation, subject assembly, decision, and publication.
 */
async function reviewAttempt(
  input: ReviewOperationInput,
  attempt: AttemptContext,
): Promise<AttemptDecision<PreparedReview, ReviewRefusal>> {
  const external = await prepareExternalReview(input);
  return await privateStateSeatAttempt(
    input.scope,
    async (seat) => {
      const observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
      const assembled = await assembleReviewAttempt(input, observation, external);
      if (assembled.kind === "stale") return STALE_PRIVATE_STATE_PREPARATION;
      return await decideAndAdmitReview(input, attempt, seat, observation, assembled);
    },
    attemptDecisionWithSeatClose,
  );
}

export async function admitReviewOperation(
  input: ReviewOperationInput,
): Promise<LeadingOutcome<ReviewAdmissionValue, ReviewRefusal>> {
  const attempts = mintAttempts({ entryCount: 1 });
  let review: Extract<AttemptDecision<PreparedReview, ReviewRefusal>, { kind: "accepted" | "refused" }> | null = null;
  for (let index = 0; index < attempts.length; index += 1) {
    const result = await reviewAttempt(input, attempts[index]!);
    if (result.kind === "accepted" || result.kind === "refused") {
      review = result;
      break;
    }
    if (result.kind === "publication-failed") return { kind: "retry", reason: result };
    if (result.kind === "stale" || result.kind === "redecide") continue;
    if (result.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: result };
  }
  if (review === null) return { kind: "retry", reason: { kind: "exhausted" } };
  if (review.kind !== "accepted") return review;
  input.progress?.recordResidue(input.contractId, review);
  return review;
}
