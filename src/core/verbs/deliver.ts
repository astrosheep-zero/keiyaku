import type { DecideInput, OfferDecision, StampedPreparation } from "../decide.js";
import {
  activeContract,
  documentIsCurrent,
  targetContractRefusal,
  type TargetContractRefusal,
} from "../facts/observation.js";
import {
  journalEntry,
  type ChangeId,
  type ContractId,
  type ContractState,
  type DeliverData,
  type DocumentKey,
} from "../facts/types.js";

type Reuse = Readonly<{ kind: "reuse"; delivery: NonNullable<ContractState["delivery"]> }>;

/** Matching a captured candidate is a pure choice, not a second mechanical preparation. */
export function matchingDelivery(state: ContractState, change: ChangeId, overwrite?: boolean) {
  const delivery = state.delivery;
  return !overwrite && delivery?.data.integration.changeId === change ? delivery : undefined;
}

export type DeliverInput<Failure = never> = Readonly<{
  contractId: ContractId;
  at: string;
  preparation: StampedPreparation<DeliverData, Failure> | (Reuse & Readonly<{ document: DocumentKey }>);
  destinationRefusal?: Failure;
}>;

export type DeliverRefusal =
  | Readonly<{ kind: "contract-missing" | "terminal" }>
  | Readonly<{ kind: "document-moved" }>
  | TargetContractRefusal;

export function decideDeliver<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<DeliverInput<Failure>>): OfferDecision<DeliverRefusal | Failure> | Reuse {
  const state = activeContract(observation, input.contractId);
  if ("kind" in state) return { kind: "refused", refusal: state };
  const targetRefusal = targetContractRefusal(observation, state.coordinates.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  if (input.destinationRefusal !== undefined) return { kind: "refused", refusal: input.destinationRefusal };
  if (input.preparation.kind === "unavailable") {
    throw new Error("existing contract requires a stamped delivery preparation");
  }
  if (!documentIsCurrent(state, input.preparation.document)) {
    return { kind: "refused", refusal: { kind: "document-moved" } };
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  if (input.preparation.kind === "reuse") return { kind: "reuse", delivery: input.preparation.delivery };
  const deliver = journalEntry("deliver", input, attempt.entryUlids[0]!, input.preparation.data);
  return { kind: "offer", offer: { facts: [{ contractId: input.contractId, entries: [deliver] }] } };
}
