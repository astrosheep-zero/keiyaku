import {
  contractJournal,
  observeContractsAt,
  selectExplicitTarget,
  type BindTargetSelection,
  type CollectContracts,
  type ContractReadView,
} from "../git/observe.js";
import { withPrivateStatePublicationSeat } from "../git/private-state-seat.js";
import { contractState } from "../core/facts/observation.js";
import { sameTarget, type ContractId, type ContractTerms, type ContractTarget } from "../core/facts/types.js";
import { readRef } from "../git/repository.js";
import { resolveContractTarget, type TargetWorkspaceRefusal } from "../git/target.js";
import { acquireTargetPlacementFence } from "../git/target-placement.js";
import { decideAmend, type AmendEdit, type AmendRefusal } from "../core/verbs/amend.js";
import {
  VERIFIED,
  type VerificationDeclarationPreparation,
  type VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import { protocolSeatClose } from "./run.js";
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

/** No target selection and no document derivation is one amendment that requests no change. */
function requestsEdit(input: AmendOperationInput): boolean {
  return input.target !== undefined || input.deriveAmendment !== undefined;
}

type Amendment = Readonly<{ source: ContractTerms; target?: ContractTarget }> &
  ReturnType<NonNullable<AmendOperationInput["deriveAmendment"]>>;
type TargetInputRefusal = Readonly<{ kind: "invalid-target" | "target-missing" }> | TargetWorkspaceRefusal;
type AmendmentRefusal = AmendRefusal | VerificationDeclarationRefusal | TargetInputRefusal;

/** An amendment either admits terms or answers that the Contract already stands as asked. */
export type AmendAdmission = IntentOutcome<Amendment, AmendmentRefusal> | Readonly<{ kind: "unchanged" }>;

/** Empty intent keeps the owner's existence and terminal judgment and admits nothing. */
async function unchangedAmend(input: AmendOperationInput): Promise<AmendAdmission> {
  const observation = await observeContractsAt(input.scope, input.channel, [input.contractId]);
  const decision = decideAmend<never>({
    input: { contractId: input.contractId, at: timestamp() },
    attempt: { entryUlids: [] },
    observation: observation.decision,
  });
  return decision.kind === "offer" ? { kind: "unchanged" } : decision;
}

async function prepareAmendmentAt(
  input: AmendOperationInput,
  selection: Extract<BindTargetSelection, { kind: "explicit" | "contract" }> | undefined,
  amendment: Amendment,
): Promise<
  Readonly<{
    observation: ContractReadView;
    target?: ContractTarget;
    preparation: AmendEdit<AmendmentRefusal>["preparation"];
  }>
> {
  const observation = await observeContractsAt(input.scope, input.channel, [input.contractId], {
    expand: async (journals, collect) => {
      const current = contractJournal(journals, input.contractId).state;
      await extendPrerequisiteClosure(collect, [...(current?.terms.after ?? []), ...amendment.terms.after]);
      if (selection?.kind === "contract") await extendTargetClosure(collect, selection.contractId);
    },
  });
  const state = contractState(observation.decision, input.contractId);
  let target: ContractTarget | undefined;
  let refusal: TargetInputRefusal | undefined;
  if (selection?.kind === "contract") {
    const resolved = await resolveContractTarget(input.scope, selection.contractId);
    if (resolved.kind === "refused") refusal = resolved.refusal;
    else target = resolved.target;
  } else if (selection?.kind === "explicit") {
    if ((await readRef(input.scope, selection.target)) === null) refusal = { kind: "target-missing" };
    else target = selection.target;
  }
  if (sameTarget(state?.coordinates.target, target)) target = undefined;
  const preparation: AmendEdit<AmendmentRefusal>["preparation"] =
    refusal !== undefined
      ? { kind: "refused", refusal }
      : amendment.verification.kind === "prepared" || !amendment.terms.gates.includes(VERIFIED)
        ? { kind: "prepared", data: { ...amendment.terms, ...(target === undefined ? {} : { target }) } }
        : { kind: "refused", refusal: amendment.verification.refusal };
  return {
    observation,
    ...(target === undefined ? {} : { target }),
    preparation,
  };
}

async function extendTargetClosure(collect: CollectContracts, seed: ContractId): Promise<void> {
  const visited = new Set<ContractId>();
  let id: ContractId | undefined = seed;
  while (id !== undefined && !visited.has(id)) {
    visited.add(id);
    const target: ContractTarget | undefined = contractJournal(await collect([id]), id).state?.coordinates.target;
    id = typeof target === "object" ? target.contractId : undefined;
  }
}

async function extendPrerequisiteClosure(collect: CollectContracts, seeds: readonly ContractId[]): Promise<void> {
  const visited = new Set<ContractId>();
  let pending = [...seeds];
  while (pending.length > 0) {
    const batch = [...new Set(pending.filter((id) => !visited.has(id)))];
    pending = [];
    if (batch.length === 0) break;
    const journals = await collect(batch);
    for (const id of batch) {
      visited.add(id);
      pending.push(...(contractJournal(journals, id).state?.terms.after ?? []));
    }
  }
}

export async function amendOperation(input: AmendOperationInput): Promise<AmendAdmission> {
  if (!requestsEdit(input)) return await unchangedAmend(input);
  const selection = input.target === undefined ? undefined : await selectExplicitTarget(input.scope, input.target);
  if (selection === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
  let source = input.source;
  if (source === undefined) {
    const initial = await observeContractsAt(input.scope, input.channel, [input.contractId]);
    source = contractState(initial.decision, input.contractId)?.terms;
  }
  // Deriving the caller-stamped document is pure: it never depends on the latest Contract.
  const amendment =
    source === undefined || input.deriveAmendment === undefined
      ? undefined
      : { source, ...input.deriveAmendment(source) };
  // A requested edit must carry observed terms; only a Contract that appeared after observation has none.
  if (amendment === undefined) throw new Error("requested amendment is missing its observed source terms");
  const incoming =
    selection?.kind === "contract" ? await acquireTargetPlacementFence(input.scope, selection.contractId) : undefined;
  try {
    return protocolSeatClose<AmendAdmission>(
      await withPrivateStatePublicationSeat<AmendAdmission>(input.scope, async (seat) => {
        const attempts = mintAttempts({ entryCount: 1 });
        for (let index = 0; index < attempts.length; index += 1) {
          const { observation, target, preparation } = await prepareAmendmentAt(input, selection, amendment);
          const decision = decideAmend({
            input: {
              contractId: input.contractId,
              at: timestamp(),
              edit: {
                source: amendment.source,
                preparation,
                ...(selection?.kind === "contract" ? { targetContract: selection.contractId } : {}),
              },
            },
            attempt: attempts[index]!,
            observation: observation.decision,
          });
          if (decision.kind !== "offer") return decision;
          const admission = await admitDecidedOffer({
            ...input,
            seat,
            observation,
            attempt: attempts[index]!,
            offer: decision.offer,
          });
          if (admission.kind === "accepted")
            return admitted(admission, { ...amendment, ...(target === undefined ? {} : { target }) });
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
