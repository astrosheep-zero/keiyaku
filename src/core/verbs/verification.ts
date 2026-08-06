import { verificationDeclarationKey } from "../declaration-key.js";
import { contractId, declarationKey, entryUlid, type ContractId, type DeclarationKey, type JournalEntry, type SnapshotId, type VerificationData } from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../decide.js";

export type VerificationInput = Readonly<{
  contractId: ContractId;
  actor?: string;
  at: string;
  data: VerificationData;
}>;

export type VerificationRefusal =
  | Readonly<{ kind: "contract-missing" | "delivery-missing" | "terminal"; contractId: ContractId }>
  | Readonly<{ kind: "candidate-mismatch"; contractId: ContractId; candidate: SnapshotId; deliveryCandidate: SnapshotId }>
  | Readonly<{ kind: "declaration-mismatch"; contractId: ContractId; declarationKey: DeclarationKey; effectiveDeclarationKey: DeclarationKey }>;

export function decideVerification({ input, attempt, observation }: DecideInput<VerificationInput>): OfferDecision<null, VerificationRefusal> {
  const id = contractId(input.contractId);
  const current = observation.contracts.get(id);
  if (!current?.state) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (current.state.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };
  if (!current.state.delivery) return { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } };
  if (input.data.candidate !== current.state.delivery.data.candidate) {
    return {
      kind: "refused",
      refusal: {
        kind: "candidate-mismatch",
        contractId: id,
        candidate: input.data.candidate,
        deliveryCandidate: current.state.delivery.data.candidate,
      },
    };
  }
  const effectiveDeclarationKey = declarationKey(verificationDeclarationKey(current.state.body!.verification));
  if (input.data.declarationKey !== effectiveDeclarationKey) {
    return {
      kind: "refused",
      refusal: {
        kind: "declaration-mismatch",
        contractId: id,
        declarationKey: input.data.declarationKey,
        effectiveDeclarationKey,
      },
    };
  }

  const verification: JournalEntry = {
    v: 1,
    kind: "verification",
    contract: id,
    entry: entryUlid(attempt.entryUlids[0]!),
    at: input.at,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    data: input.data,
  };
  return { kind: "offer", offer: { facts: [{ contractId: id, expectedHead: current.state.head, entries: [verification] }] }, handoff: null };
}
