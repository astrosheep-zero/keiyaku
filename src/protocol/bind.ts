import { randomBytes } from "node:crypto";
import { normalizeTargetBranch, observeBindCoordinates } from "../git/observe.js";
import { gitObjectIdForSnapshot } from "../git/identity.js";
import type { GitRefAssertion, GitRepository } from "../git/repository.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { BindData, ActorId, ContractId } from "../core/facts/types.js";
import { contractIdFromSegment } from "../core/facts/types.js";
import { decideBind, type BindInput, type BindRefusal } from "../core/verbs/bind.js";
export type { BindRefusal } from "../core/verbs/bind.js";
import { fitIdentityStem, normalizeIdentityStem } from "../identity/normalize.js";
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
    }>;

type BindOperationInput = Readonly<{
  scope: GitRepository;
  channel: GitDecodeChannel;
  title: string;
  terms: BindData["terms"];
  verification: VerificationDeclarationPreparation;
  target?: string;
  workspace: "worktree" | "here";
  actor?: ActorId;
  decorateOffer?: CompanionDecorator;
}>;

const CONTRACT_ID_STEM_BYTES = 72;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function mintCollisionSuffix(): string {
  let random = BigInt(`0x${randomBytes(5).toString("hex")}`);
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix = CROCKFORD_BASE32[Number(random & 31n)]! + suffix;
    random >>= 5n;
  }
  return suffix.toLowerCase();
}

function contractIdFromStem(stem: string, suffix?: string): ContractId {
  return contractIdFromSegment(fitIdentityStem({
    stem,
    maxBytes: CONTRACT_ID_STEM_BYTES,
    ...(suffix === undefined ? {} : { suffix }),
  }));
}

type BindRefusalUnion = BindRefusal | TargetInputRefusal | VerificationDeclarationRefusal;
type BindSeed = Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>;

function bindPreparation(
  input: BindOperationInput,
  target: string | undefined,
  seed: BindSeed,
): Readonly<{ kind: "prepared"; input: BindInput<VerificationDeclarationRefusal>; assertions?: readonly GitRefAssertion[] }>
  | Readonly<{ kind: "refused"; refusal: BindRefusalUnion }> {
  if (input.verification.kind === "refused") {
    return { kind: "prepared", input: { ...seed, preparation: input.verification } };
  }
  const observed = observeBindCoordinates(input.scope, target);
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
    const normalized = normalizeTargetBranch(input.scope, input.target);
    if (normalized === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
    target = normalized;
  }
  const stem = normalizeIdentityStem({ source: input.title }) || "contract";
  const at = new Date().toISOString();
  const attempt = async (id: ContractId): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusalUnion>> => complete(
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
        prepareInput: (_observation, original) => bindPreparation(input, target, original),
        ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
      },
    ),
    { contractId: id },
  );
  const first = await attempt(contractIdFromStem(stem));
  return first.kind === "refused" && first.refusal.kind === "contract-exists"
    ? await attempt(contractIdFromStem(stem, mintCollisionSuffix()))
    : first;
}
