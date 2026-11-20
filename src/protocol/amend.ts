import {
  contractJournal,
  observeContractsAt,
  selectExplicitTarget,
  type BindTargetSelection,
  type CollectContracts,
} from "../git/observe.js";
import { contractState } from "../core/facts/observation.js";
import {
  sameTarget,
  type ContractHead,
  type ContractId,
  type ContractTerms,
  type ContractTarget,
} from "../core/facts/types.js";
import { readRef } from "../git/repository.js";
import { resolveContractTarget, targetRef, type TargetWorkspaceRefusal } from "../git/target.js";
import { gitObjectIdForSnapshot } from "../git/identity.js";
import { acquireTargetPlacementFence } from "../git/target-placement.js";
import { decideAmend, type AmendEdit, type AmendRefusal } from "../core/verbs/amend.js";
import {
  VERIFIED,
  type VerificationDeclarationPreparation,
  type VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitDecidedOffer, mintAttempts } from "./attempt.js";
import { admitted } from "./outcome.js";
import {
  privateStateSeatAttempt,
  preparationIsCurrent,
  runBoundedAttempts,
  spentPreparation,
  type ObservedRef,
  type ProtocolTerminal,
  type SpentPreparation,
} from "./run.js";
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

type AmendFinal = Extract<AmendAdmission, Readonly<{ kind: "accepted" | "unchanged" }>>;
type PreparedAmendment = Readonly<{
  expectedHead: ContractHead | null;
  amendment?: Amendment;
  prepared?: Awaited<ReturnType<typeof prepareAmendmentAt>>;
}>;

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
  currentTarget: ContractTarget | undefined,
) {
  let target: ContractTarget | undefined;
  let expectedRef: ObservedRef | undefined;
  let refusal: TargetInputRefusal | VerificationDeclarationRefusal | undefined;
  if (selection?.kind === "contract") {
    const resolved = await resolveContractTarget(input.scope, selection.contractId);
    if (resolved.kind === "refused") refusal = resolved.refusal;
    else {
      target = resolved.target;
      expectedRef = { ref: targetRef(target), oid: gitObjectIdForSnapshot(resolved.head) };
    }
  } else if (selection?.kind === "explicit") {
    expectedRef = { ref: selection.target, oid: await readRef(input.scope, selection.target) };
    if (expectedRef.oid === null) refusal = { kind: "target-missing" };
    else target = selection.target;
  }
  if (amendment.verification.kind === "refused" && amendment.terms.gates.includes(VERIFIED)) {
    refusal ??= amendment.verification.refusal;
  }
  const replacement = sameTarget(currentTarget, target) ? undefined : target;
  const preparation: AmendEdit<AmendmentRefusal>["preparation"] =
    refusal !== undefined
      ? { kind: "refused", refusal }
      : {
          kind: "prepared",
          data: { ...amendment.terms, ...(replacement === undefined ? {} : { target: replacement }) },
        };
  return { target, replacement, expectedRef, preparation };
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

async function prepareAmendAttempt(
  input: AmendOperationInput,
  selection: Extract<BindTargetSelection, { kind: "explicit" | "contract" }> | undefined,
  contractId: ContractId,
): Promise<PreparedAmendment> {
  const before = await observeContractsAt(input.scope, input.channel, [contractId]);
  const state = contractState(before.decision, contractId);
  const source = input.source ?? state?.terms;
  const amendment =
    source === undefined || input.deriveAmendment === undefined
      ? undefined
      : { source, ...input.deriveAmendment(source) };
  const prepared =
    amendment === undefined
      ? undefined
      : await prepareAmendmentAt(input, selection, amendment, state?.coordinates.target);
  return {
    expectedHead: state?.head ?? null,
    ...(amendment === undefined ? {} : { amendment }),
    ...(prepared === undefined ? {} : { prepared }),
  };
}

export async function amendOperation(input: AmendOperationInput): Promise<AmendAdmission> {
  if (!requestsEdit(input)) return await unchangedAmend(input);
  const selection = input.target === undefined ? undefined : await selectExplicitTarget(input.scope, input.target);
  if (selection === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
  const { scope, channel, contractId } = input;
  const targetContract = selection?.kind === "contract" ? selection.contractId : undefined;
  const incoming = targetContract === undefined ? undefined : await acquireTargetPlacementFence(scope, targetContract);
  try {
    const result = await runBoundedAttempts<PreparedAmendment, AmendFinal, AmendmentRefusal>(
      mintAttempts({ entryCount: 1 }),
      async () => ({ kind: "prepared", prepared: await prepareAmendAttempt(input, selection, contractId) }),
      async ({ expectedHead, amendment, prepared }, attempt) =>
        await privateStateSeatAttempt<
          AmendFinal | Readonly<{ kind: "refused"; refusal: AmendmentRefusal }> | SpentPreparation | ProtocolTerminal
        >(scope, async (seat) => {
          const observation = await observeContractsAt(scope, channel, [contractId], {
            expand: async (journals, collect) => {
              const fresh = contractJournal(journals, contractId).state;
              await extendPrerequisiteClosure(collect, [
                ...new Set([...(fresh?.terms.after ?? []), ...(amendment?.terms.after ?? [])]),
              ]);
              if (targetContract !== undefined) await extendTargetClosure(collect, targetContract);
            },
          });
          if (!(await preparationIsCurrent(scope, observation, contractId, expectedHead, prepared?.expectedRef))) {
            return spentPreparation;
          }
          let edit: AmendEdit<AmendmentRefusal> | undefined;
          if (amendment !== undefined && prepared !== undefined) {
            edit = {
              source: amendment.source,
              preparation: prepared.preparation,
              ...(targetContract === undefined ? {} : { targetContract }),
            };
          }
          const decision = decideAmend({
            input: { contractId, at: timestamp(), ...(edit === undefined ? {} : { edit }) },
            attempt,
            observation: observation.decision,
          });
          if (decision.kind !== "offer") return decision;
          if (amendment === undefined || prepared === undefined)
            throw new Error("offered amendment lacks prepared terms");
          const { expectedRef } = prepared;
          if (prepared.target !== undefined && typeof prepared.target !== "string") {
            const resolved = await resolveContractTarget(scope, prepared.target.contractId, prepared.target);
            if (resolved.kind === "refused") return resolved;
          }
          const admission = await admitDecidedOffer({
            ...input,
            seat,
            observation,
            attempt,
            offer: decision.offer,
            assertions: expectedRef?.oid == null ? [] : [{ ref: expectedRef.ref, oid: expectedRef.oid }],
          });
          if (admission.kind !== "accepted") return admission;
          return admitted(admission, {
            ...amendment,
            ...(prepared.replacement === undefined ? {} : { target: prepared.replacement }),
          });
        }),
    );
    return result.kind === "exhausted" || result.kind === "collision" || result.kind === "publication-failed"
      ? { kind: "retry", reason: result }
      : result;
  } finally {
    incoming?.close();
  }
}
