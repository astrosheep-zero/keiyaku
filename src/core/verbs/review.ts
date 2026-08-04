import type {
  CommitOid,
  ContractId,
  EntryUlid,
  Phase,
  ReviewEntry,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type ReviewChangesRequestedInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  data: Readonly<{
    digest: string;
    summary: string;
  }>;
}>;

export type ReviewChangesRequestedRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-awaiting-verdict"; contractId: ContractId; phase: Phase }>;

export type ReviewApprovedInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  data: Readonly<{
    digest: string;
    summary: string;
  }>;
}>;

export type ReviewApprovedRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-awaiting-verdict"; contractId: ContractId; phase: Phase }>
  | Readonly<{ kind: "petition-missing"; contractId: ContractId }>
  | Readonly<{ kind: "delivery-missing"; contractId: ContractId }>
  | Readonly<{
    kind: "petition-delivery-head-mismatch";
    contractId: ContractId;
    petitionDeliveryHead: CommitOid;
    deliveryHead: CommitOid;
  }>;

function requiredEntryUlid(input: DecideInput<ReviewChangesRequestedInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("review changes requested requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

function cloneReviewChangesRequestedData(data: ReviewChangesRequestedInput["data"]): ReviewChangesRequestedInput["data"] {
  return { digest: data.digest, summary: data.summary };
}

function cloneReviewApprovedData(data: ReviewApprovedInput["data"]): ReviewApprovedInput["data"] {
  return { digest: data.digest, summary: data.summary };
}

/** Decide one changes-requested review admission from one already-captured protocol observation. */
export function decideReviewChangesRequested(
  input: DecideInput<ReviewChangesRequestedInput>,
): OfferDecision<null, ReviewChangesRequestedRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`review contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state === null) {
    return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.input.contractId } };
  }
  if (observed.state.phase !== "awaiting-verdict") {
    return {
      kind: "refused",
      refusal: {
        kind: "phase-not-awaiting-verdict",
        contractId: input.input.contractId,
        phase: observed.state.phase,
      },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`review contract has no observed journal head: ${input.input.contractId}`);
  }

  const data = cloneReviewChangesRequestedData(input.input.data);
  const review: ReviewEntry = {
    v: 1,
    kind: "review",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: {
      verdict: "changes-requested",
      digest: data.digest,
      summary: data.summary,
      evidence: [],
    },
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [review] }],
    },
    handoff: null,
  };
}

/** Decide one approved review admission from one already-captured protocol observation. */
export function decideReviewApproved(
  input: DecideInput<ReviewApprovedInput>,
): OfferDecision<null, ReviewApprovedRefusal> {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("review approved requires exactly one fresh entry ULID");
  }
  const entry = input.attempt.entryUlids[0]!;
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`review contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state === null) {
    return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.input.contractId } };
  }
  if (observed.state.phase !== "awaiting-verdict") {
    return {
      kind: "refused",
      refusal: {
        kind: "phase-not-awaiting-verdict",
        contractId: input.input.contractId,
        phase: observed.state.phase,
      },
    };
  }
  if (observed.state.petition === null) {
    return { kind: "refused", refusal: { kind: "petition-missing", contractId: input.input.contractId } };
  }
  if (observed.state.delivery === null) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId: input.input.contractId } };
  }
  if (observed.state.petition.data.deliveryHead !== observed.state.delivery.head) {
    return {
      kind: "refused",
      refusal: {
        kind: "petition-delivery-head-mismatch",
        contractId: input.input.contractId,
        petitionDeliveryHead: observed.state.petition.data.deliveryHead,
        deliveryHead: observed.state.delivery.head,
      },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`review contract has no observed journal head: ${input.input.contractId}`);
  }

  const data = cloneReviewApprovedData(input.input.data);
  const review: ReviewEntry = {
    v: 1,
    kind: "review",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: {
      verdict: "approved",
      reviewedHead: observed.state.delivery.head,
      digest: data.digest,
      summary: data.summary,
      evidence: [],
    },
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [review] }],
    },
    handoff: null,
  };
}
