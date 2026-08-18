import { extendContractsForAdmissionAt, observeContractsForAdmissionAt } from "../git/observe.js";
import { contractState } from "../core/facts/observation.js";
import type { AmendData, ContractId, ContractTerms } from "../core/facts/types.js";
import { decideAmend, type AmendInput, type AmendRefusal } from "../core/verbs/amend.js";
import type {
  VerificationDeclarationPreparation,
  VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import type { GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { MutationOperationInput, IntentOutcome } from "./operations.js";
import { timestamp } from "./operations.js";

type AmendOperationInput = MutationOperationInput & Readonly<{
  source?: ContractTerms;
  deriveAmendment?: (source: ContractTerms) => Readonly<{
    terms: AmendData;
    verification: VerificationDeclarationPreparation;
  }>;
}>;

type Amendment = Readonly<{ source: ContractTerms }>
  & ReturnType<NonNullable<AmendOperationInput["deriveAmendment"]>>;

async function extendPrerequisiteClosureAt(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  seeds: readonly ContractId[],
): Promise<GitDecisionObservation> {
  let current = observation;
  const visited = new Set<ContractId>();
  let pending = [...seeds];
  while (pending.length > 0) {
    const batch = [...new Set(pending.filter((id) => !visited.has(id)))];
    pending = [];
    if (batch.length === 0) break;
    current = await extendContractsForAdmissionAt(channel, current, batch);
    for (const id of batch) {
      visited.add(id);
      const state = contractState(current.decision, id);
      if (state !== null) pending.push(...state.terms.after);
    }
  }
  return current;
}

export async function amendOperation(
  input: AmendOperationInput,
): Promise<IntentOutcome<Amendment, AmendRefusal | VerificationDeclarationRefusal>> {
  const attempts = mintAttempts({ entryCount: 1 });
  let source = input.source;
  for (let index = 0; index < attempts.length; index += 1) {
    let observation = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
    const state = contractState(observation.decision, input.contractId);
    if (source === undefined && state !== null) source = state.terms;
    const amendment = source === undefined || input.deriveAmendment === undefined
      ? undefined
      : { source, ...input.deriveAmendment(source) };
    if (amendment !== undefined) {
      observation = await extendPrerequisiteClosureAt(
        input.channel,
        observation,
        [...new Set([...(state?.terms.after ?? []), ...amendment.terms.after])],
      );
    }
    const preparation: AmendInput<VerificationDeclarationRefusal>["preparation"] = amendment === undefined
      ? undefined
      : amendment.verification.kind === "prepared"
        ? { kind: "prepared", data: amendment.terms }
        : { kind: "refused", refusal: amendment.verification.refusal };
    const decision = decideAmend({
      input: {
        contractId: input.contractId,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        at: timestamp(),
        ...(amendment === undefined ? {} : { source: amendment.source }),
        ...(preparation === undefined ? {} : { preparation }),
      },
      attempt: attempts[index]!,
      observation: observation.decision,
    });
    if (decision.kind === "refused") return decision;
    const admission = await admitDecidedOffer({
      channel: input.channel,
      repository: input.scope,
      decisionObservation: observation,
      attempt: attempts[index]!,
      offer: decision.offer,
      primaryContract: input.contractId,
    });
    if (admission.kind === "accepted") {
      if (amendment === undefined) throw new Error("accepted amendment is missing its document derivation");
      return admitted(admission, amendment);
    }
    if (admission.kind === "publication-failed") return { kind: "retry", reason: admission };
    if (admission.kind === "collision" && index + 1 === attempts.length) return { kind: "retry", reason: admission };
  }
  return { kind: "retry", reason: { kind: "exhausted" } };
}
