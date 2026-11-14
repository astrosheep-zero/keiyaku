import {
  extendContractsForAdmissionAt,
  observeContractsForAdmissionAt,
  selectExplicitTarget,
  type BindTargetSelection,
} from "../git/observe.js";
import { withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
import { contractState } from "../core/facts/observation.js";
import { sameTarget, type ContractId, type ContractTerms, type ContractTarget } from "../core/facts/types.js";
import { readRef } from "../git/repository.js";
import { resolveContractTarget, type TargetWorkspaceRefusal } from "../git/target.js";
import { acquireTargetPlacementFence } from "../git/target-placement.js";
import { decideAmend, type AmendInput, type AmendRefusal } from "../core/verbs/amend.js";
import {
  VERIFIED,
  type VerificationDeclarationPreparation,
  type VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import { protocolSeatClose } from "./run.js";
import type { GitDecisionObservation } from "../git/observe.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { MutationOperationInput, IntentOutcome } from "./operations.js";
import { timestamp } from "./operations.js";

type AmendOperationInput = MutationOperationInput &
  Readonly<{
    source?: ContractTerms;
    target?: string;
    deriveAmendment?: (source: ContractTerms) => Readonly<{
      terms: ContractTerms;
      verification: VerificationDeclarationPreparation;
    }>;
  }>;

type Amendment = Readonly<{ source: ContractTerms; target?: ContractTarget }> &
  ReturnType<NonNullable<AmendOperationInput["deriveAmendment"]>>;
type TargetInputRefusal = Readonly<{ kind: "invalid-target" | "target-missing" }> | TargetWorkspaceRefusal;
type AmendmentRefusal = AmendRefusal | VerificationDeclarationRefusal | TargetInputRefusal;

async function prepareAmendmentAt(
  input: AmendOperationInput,
  selection: Extract<BindTargetSelection, { kind: "explicit" | "contract" }> | undefined,
  amendment: Amendment | undefined,
  observation: GitDecisionObservation,
): Promise<
  Readonly<{
    observation: GitDecisionObservation;
    target?: ContractTarget;
    preparation?: AmendInput<AmendmentRefusal>["preparation"];
  }>
> {
  const state = contractState(observation.decision, input.contractId);
  if (amendment !== undefined) {
    observation = await extendPrerequisiteClosureAt(input.channel, observation, [
      ...new Set([...(state?.terms.after ?? []), ...amendment.terms.after]),
    ]);
  }
  let target: ContractTarget | undefined;
  let refusal: TargetInputRefusal | undefined;
  if (selection?.kind === "contract") {
    observation = await extendTargetClosureAt(input.channel, observation, selection.contractId);
    const resolved = await resolveContractTarget(input.scope, selection.contractId);
    if (resolved.kind === "refused") refusal = resolved.refusal;
    else target = resolved.target;
  } else if (selection?.kind === "explicit") {
    if ((await readRef(input.scope, selection.target)) === null) refusal = { kind: "target-missing" };
    else target = selection.target;
  }
  if (sameTarget(state?.coordinates.target, target)) target = undefined;
  const preparation: AmendInput<AmendmentRefusal>["preparation"] =
    amendment === undefined
      ? undefined
      : refusal !== undefined
        ? { kind: "refused", refusal }
        : amendment.verification.kind === "prepared" || !amendment.terms.gates.includes(VERIFIED)
          ? { kind: "prepared", data: { ...amendment.terms, ...(target === undefined ? {} : { target }) } }
          : { kind: "refused", refusal: amendment.verification.refusal };
  return {
    observation,
    ...(target === undefined ? {} : { target }),
    ...(preparation === undefined ? {} : { preparation }),
  };
}

async function extendTargetClosureAt(
  channel: GitDecodeChannel,
  observation: GitDecisionObservation,
  seed: ContractId,
): Promise<GitDecisionObservation> {
  let current = observation;
  const visited = new Set<ContractId>();
  let id: ContractId | undefined = seed;
  while (id !== undefined && !visited.has(id)) {
    visited.add(id);
    current = await extendContractsForAdmissionAt(channel, current, [id]);
    const target: ContractTarget | undefined = contractState(current.decision, id)?.coordinates.target;
    id = typeof target === "object" ? target.contractId : undefined;
  }
  return current;
}

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

export async function amendOperation(input: AmendOperationInput): Promise<IntentOutcome<Amendment, AmendmentRefusal>> {
  const selection = input.target === undefined ? undefined : await selectExplicitTarget(input.scope, input.target);
  if (selection === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
  let source = input.source;
  if (source === undefined) {
    const initial = await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]);
    source = contractState(initial.decision, input.contractId)?.terms;
  }
  // Deriving the caller-stamped document is pure: it never depends on the latest Contract.
  const amendment =
    source === undefined || input.deriveAmendment === undefined
      ? undefined
      : { source, ...input.deriveAmendment(source) };
  const incoming =
    selection?.kind === "contract" ? await acquireTargetPlacementFence(input.scope, selection.contractId) : undefined;
  try {
    return protocolSeatClose<IntentOutcome<Amendment, AmendmentRefusal>>(
      await withPrivateStatePublicationSeat<IntentOutcome<Amendment, AmendmentRefusal>>(input.scope, async (seat) => {
        const attempts = mintAttempts({ entryCount: 1 });
        for (let index = 0; index < attempts.length; index += 1) {
          const { observation, target, preparation } = await prepareAmendmentAt(
            input,
            selection,
            amendment,
            await observeContractsForAdmissionAt(input.scope, input.channel, [input.contractId]),
          );
          const decision = decideAmend({
            input: {
              contractId: input.contractId,
              at: timestamp(),
              ...(amendment === undefined ? {} : { source: amendment.source }),
              ...(selection?.kind === "contract" ? { targetContract: selection.contractId } : {}),
              ...(preparation === undefined ? {} : { preparation }),
            },
            attempt: attempts[index]!,
            observation: observation.decision,
          });
          if (decision.kind === "refused") return decision;
          const admission = await admitDecidedOffer({
            ...input,
            seat,
            observation,
            attempt: attempts[index]!,
            offer: decision.offer,
          });
          if (admission.kind === "accepted") {
            if (amendment === undefined) throw new Error("accepted amendment is missing its document derivation");
            return admitted(admission, { ...amendment, ...(target === undefined ? {} : { target }) });
          }
          if (admission.kind === "publication-failed") return { kind: "retry", reason: admission };
          if (admission.kind === "collision" && index + 1 === attempts.length)
            return { kind: "retry", reason: admission };
        }
        return { kind: "retry", reason: { kind: "exhausted" } };
      }),
    );
  } finally {
    incoming?.close();
  }
}
