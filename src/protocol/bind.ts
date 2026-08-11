import { randomBytes } from "node:crypto";
import { normalizeTargetBranch, observeBindCoordinates } from "../git/observe.js";
import type { GitRepository } from "../git/repository.js";
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
  | Readonly<{ kind: "target-missing" }>;

type BindOperationInput = Readonly<{
  scope: GitRepository;
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

export function bindOperation(
  input: BindOperationInput,
): IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusal | TargetInputRefusal | VerificationDeclarationRefusal> {
  let target: string | undefined;
  if (input.target !== undefined) {
    const normalized = normalizeTargetBranch(input.scope, input.target);
    if (normalized === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
    target = normalized;
  }
  const observed = observeBindCoordinates(input.scope, target);
  if (observed === null) return { kind: "refused", refusal: { kind: "target-missing" } };
  const data: BindData = {
    coordinates: {
      start: observed.start,
      ...(observed.target === undefined ? {} : { target: observed.target }),
      workspace: input.workspace,
    },
    terms: input.terms,
  };
  const stem = normalizeIdentityStem({ source: input.title }) || "contract";
  const at = new Date().toISOString();
  const attempt = (id: ContractId): IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusal | VerificationDeclarationRefusal> => complete(
    admitIntent(
      input.scope,
      {
        contractId: id,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        at,
        preparation: input.verification.kind === "prepared"
          ? { kind: "prepared", data }
          : { kind: "refused", refusal: input.verification.refusal },
      } satisfies BindInput<VerificationDeclarationRefusal>,
      decideBind,
      {
        observedContracts: [id, ...input.terms.after],
        ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
      },
    ),
    { contractId: id },
  );
  const first = attempt(contractIdFromStem(stem));
  return first.kind === "refused" && first.refusal.kind === "contract-exists"
    ? attempt(contractIdFromStem(stem, mintCollisionSuffix()))
    : first;
}
