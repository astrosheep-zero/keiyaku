import { normalizeTargetBranch, observeBindCoordinates } from "../git/observe.js";
import { gitObjectIdForSnapshot } from "../git/identity.js";
import type { GitRefAssertion, GitRepository } from "../git/repository.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { BindData, ActorId, ContractId } from "../core/facts/types.js";
import { decideBind, type BindInput, type BindRefusal } from "../core/verbs/bind.js";
export type { BindRefusal } from "../core/verbs/bind.js";
import type { VerificationDeclarationPreparation, VerificationDeclarationRefusal } from "../verification/declaration.js";
import { admitIntent } from "./intent.js";
import { complete, type IntentOutcome } from "./outcome.js";
import type { CompanionDecorator } from "./run.js";

export type TargetInputRefusal =
  | Readonly<{ kind: "invalid-target" }>
  | Readonly<{ kind: "target-missing" }>
  | Readonly<{
      kind: "here-target-mismatch";
      target: string;
      branch: string | null;
    }>
  ;

type BindOperationInput = Readonly<{
  scope: GitRepository;
  channel: GitDecodeChannel;
  terms: BindData["terms"];
  verification: VerificationDeclarationPreparation;
  target?: string;
  workspace: "worktree" | "here";
  actor?: ActorId;
  decorateOffer?: CompanionDecorator;
  contractId: ContractId;
}>;

type BindRefusalUnion = BindRefusal | TargetInputRefusal | VerificationDeclarationRefusal;
type BindSeed = Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>;

async function bindPreparation(
  input: BindOperationInput,
  target: string | undefined,
  seed: BindSeed,
): Promise<
  Readonly<{ kind: "prepared"; input: BindInput<VerificationDeclarationRefusal>; assertions?: readonly GitRefAssertion[] }>
  | Readonly<{ kind: "refused"; refusal: BindRefusalUnion }>
> {
  if (input.verification.kind === "refused") {
    return { kind: "prepared", input: { ...seed, preparation: input.verification } };
  }
  const observed = await observeBindCoordinates(input.scope, target);
  if (observed === null) return { kind: "refused", refusal: { kind: "target-missing" } };
  if (input.workspace === "here" && target !== undefined && observed.branch !== target) {
    return { kind: "refused", refusal: { kind: "here-target-mismatch", target, branch: observed.branch } };
  }
  const oid = gitObjectIdForSnapshot(observed.start);
  const assertions: GitRefAssertion[] = [{ ref: target ?? "HEAD", oid }];
  return {
    kind: "prepared",
    input: {
      ...seed,
      preparation: {
        kind: "prepared",
        data: {
          coordinates: {
            start: observed.start,
            ...(observed.target === undefined ? {} : { target: observed.target }),
            workspace: input.workspace,
          },
          terms: input.terms,
        },
      },
    },
    assertions,
  };
}

export async function bindOperation(
  input: BindOperationInput,
): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusal | TargetInputRefusal | VerificationDeclarationRefusal>> {
  let target: string | undefined;
  if (input.target !== undefined) {
    const normalized = await normalizeTargetBranch(input.scope, input.target);
    if (normalized === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
    target = normalized;
  }
  const at = new Date().toISOString();
  const id = input.contractId;
  return complete(
    await admitIntent<BindInput<VerificationDeclarationRefusal>, BindRefusalUnion, BindSeed>(
      input.channel,
      input.scope,
      {
        contractId: id,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        at,
      } satisfies BindSeed,
      decideBind,
      {
        observedContracts: [id, ...input.terms.after],
        prepareInput: async (_observation, original) => bindPreparation(input, target, original),
        ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
      },
    ),
    { contractId: id },
  );
}
