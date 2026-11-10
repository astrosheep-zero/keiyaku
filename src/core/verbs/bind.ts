import type { DecideInput, OfferDecision, Preparation } from "../decide.js";
import {
  contractState,
  prerequisiteStatus,
  targetContractIdRefusal,
  targetContractRefusal,
  type TargetContractRefusal,
} from "../facts/observation.js";
import { journalEntry, type ActorId, type BindData, type ContractId } from "../facts/types.js";

export type BindInput<Failure = never> = Readonly<{
  contractId: ContractId;
  actor?: ActorId;
  at: string;
  preparation: Preparation<BindData, Failure>;
  targetContract?: ContractId;
}>;

export type BindRefusal =
  | Readonly<{
      kind: "contract-exists" | "invalid-after" | "unknown-prerequisite";
    }>
  | TargetContractRefusal;

export function decideBind<Failure>({
  input,
  attempt,
  observation,
}: DecideInput<BindInput<Failure>>): OfferDecision<BindRefusal | Failure> {
  const id = input.contractId;
  const current = contractState(observation, id);
  if (current !== null) return { kind: "refused", refusal: { kind: "contract-exists" } };
  if (input.targetContract !== undefined) {
    const refusal = targetContractIdRefusal(observation, input.targetContract);
    if (refusal !== undefined) return { kind: "refused", refusal };
  }
  if (input.preparation.kind === "refused") return { kind: "refused", refusal: input.preparation.refusal };
  const { data } = input.preparation;
  const targetRefusal = targetContractRefusal(observation, data.coordinates.target);
  if (targetRefusal !== undefined) return { kind: "refused", refusal: targetRefusal };
  if (data.terms.after.includes(id)) return { kind: "refused", refusal: { kind: "invalid-after" } };
  const prerequisites = prerequisiteStatus(data.terms.after, observation);
  if (prerequisites === "unknown") {
    return { kind: "refused", refusal: { kind: "unknown-prerequisite" } };
  }
  const bind = journalEntry("bind", input, attempt.entryUlids[0]!, data);
  return { kind: "offer", offer: { facts: [{ contractId: id, entries: [bind] }] } };
}
