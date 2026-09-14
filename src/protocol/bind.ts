import {
  normalizeTargetBranch,
  observeBindCoordinates,
  type BindCoordinatesObservation,
  type BindTargetSelection,
} from "../git/observe.js";
export type { BindTargetSelection };
import { gitObjectIdForSnapshot } from "../git/identity.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import { contractId, type BindData, type ActorId, type ContractId } from "../core/facts/types.js";
import { decideBind, type BindInput, type BindRefusal } from "../core/verbs/bind.js";
export type { BindRefusal } from "../core/verbs/bind.js";
import type {
  VerificationDeclarationPreparation,
  VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitPreparedIntent } from "./intent.js";
import { complete, type IntentOutcome } from "./outcome.js";
import type { ExternalProtocolPreparation, InCustodyProtocolPreparation, CompanionDecorator } from "./run.js";
export type TargetInputRefusal =
  | Readonly<{ kind: "invalid-target" }>
  | Readonly<{ kind: "target-missing" }>
  | Readonly<{ kind: "unborn-head" }>;
export type ForkSourceMovedRefusal = Readonly<{ kind: "fork-source-moved"; contractId: ContractId }>;

export function decodeTargetInputRefusal(value: unknown): TargetInputRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed target input refusal");
  const object = value as Record<string, unknown>;
  if (object.kind !== "invalid-target" && object.kind !== "target-missing" && object.kind !== "unborn-head")
    throw new Error("malformed target input refusal");
  if (Object.keys(object).length !== 1) throw new Error("malformed target input refusal");
  return { kind: object.kind };
}

export function decodeForkSourceMovedRefusal(value: unknown): ForkSourceMovedRefusal {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("malformed fork-source refusal");
  const object = value as Record<string, unknown>;
  if (object.kind !== "fork-source-moved") throw new Error("malformed fork-source refusal");
  if (Object.keys(object).some((key) => key !== "kind" && key !== "contractId"))
    throw new Error("malformed fork-source refusal");
  try {
    return { kind: "fork-source-moved", contractId: contractId(String(object.contractId)) };
  } catch {
    throw new Error("malformed fork-source refusal");
  }
}

type BindOperationInput = Readonly<{
  scope: GitRepository;
  channel: GitDecodeChannel;
  terms: BindData["terms"];
  verification: VerificationDeclarationPreparation;
  targetSelection?: BindTargetSelection;
  workspace: "worktree";
  actor?: ActorId;
  decorateOffer?: CompanionDecorator;
  contractId: ContractId;
  coordinates?: Readonly<{ start: import("../core/facts/types.js").SnapshotId }>;
  source?: Readonly<{
    contractId: ContractId;
    head: import("../core/facts/types.js").ContractHead | null;
    start: import("../core/facts/types.js").SnapshotId;
    document: import("../core/facts/types.js").DocumentKey;
  }>;
}>;

type BindRefusalUnion = BindRefusal | TargetInputRefusal | VerificationDeclarationRefusal | ForkSourceMovedRefusal;
type BindSeed = Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>;
type RefusedVerificationDeclaration = Extract<VerificationDeclarationPreparation, Readonly<{ kind: "refused" }>>;

/** What one seat-external coordinate acquisition proves about the mutable Git coordinates. */
type BindCoordinatesPreparation =
  | Readonly<{ kind: "resolved"; observed: BindCoordinatesObservation }>
  | Readonly<{ kind: "unresolved"; reason: "target-missing" | "unborn-head" }>
  | Readonly<{ kind: "declaration-refused"; preparation: RefusedVerificationDeclaration }>;

/**
 * Acquire the repeatable Git coordinates outside the publication seat. The artifact carries the
 * observed start/target plus the expected ref assertions that publication must still confirm.
 */
async function prepareBindCoordinates(
  input: BindOperationInput,
  selection: BindTargetSelection,
): Promise<ExternalProtocolPreparation<BindCoordinatesPreparation, BindRefusalUnion>> {
  if (input.verification.kind === "refused") {
    return { kind: "prepared", prepared: { kind: "declaration-refused", preparation: input.verification } };
  }
  const observed = await observeBindCoordinates(input.scope, selection);
  if (observed === null) return { kind: "prepared", prepared: { kind: "unresolved", reason: "target-missing" } };
  if ("kind" in observed) return { kind: "prepared", prepared: { kind: "unresolved", reason: "unborn-head" } };
  return {
    kind: "prepared",
    prepared: { kind: "resolved", observed },
    ...(input.coordinates === undefined
      ? { assertions: [{ ref: observed.target ?? "HEAD", oid: gitObjectIdForSnapshot(observed.start) }] }
      : {}),
  };
}

/**
 * Assemble the decision input from the fresh in-custody observation. Coordinates fixed by the
 * invocation are never replaced; mutable coordinate disappearance is read again as current evidence.
 */
async function assembleBindInput(
  input: BindOperationInput,
  selection: BindTargetSelection,
  seed: BindSeed,
  prepared: BindCoordinatesPreparation,
): Promise<InCustodyProtocolPreparation<BindInput<VerificationDeclarationRefusal>, BindRefusalUnion>> {
  if (prepared.kind === "declaration-refused") {
    return { kind: "prepared", input: { ...seed, preparation: prepared.preparation } };
  }
  if (prepared.kind === "unresolved") {
    const current = await observeBindCoordinates(input.scope, selection);
    if (current === null) return { kind: "refused", refusal: { kind: "target-missing" } };
    if ("kind" in current) return { kind: "refused", refusal: { kind: "unborn-head" } };
    return { kind: "stale" };
  }
  const observed = prepared.observed;
  return {
    kind: "prepared",
    input: {
      ...seed,
      preparation: {
        kind: "prepared",
        data: {
          coordinates: {
            start: input.coordinates?.start ?? observed.start,
            ...(observed.target === undefined ? {} : { target: observed.target }),
            workspace: input.workspace,
          },
          terms: input.terms,
        },
      },
    },
  };
}

export async function bindOperation(
  input: BindOperationInput,
): Promise<
  IntentOutcome<
    Readonly<{ contractId: ContractId }>,
    BindRefusal | TargetInputRefusal | VerificationDeclarationRefusal | ForkSourceMovedRefusal
  >
> {
  let selection: BindTargetSelection = input.targetSelection ?? { kind: "targetless" };
  if (selection.kind === "explicit") {
    const normalized = await normalizeTargetBranch(input.scope, selection.target);
    if (normalized === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
    selection = { kind: "explicit", target: normalized };
  }
  const at = new Date().toISOString();
  const id = input.contractId;
  return complete(
    await admitPreparedIntent<
      BindInput<VerificationDeclarationRefusal>,
      BindRefusalUnion,
      BindSeed,
      BindCoordinatesPreparation
    >(
      input.channel,
      input.scope,
      {
        contractId: id,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        at,
      } satisfies BindSeed,
      decideBind,
      {
        observedContracts: [id, ...input.terms.after, ...(input.source === undefined ? [] : [input.source.contractId])],
        preparation: {
          external: async () => await prepareBindCoordinates(input, selection),
          assemble: async (_observation, original, prepared) =>
            await assembleBindInput(input, selection, original, prepared),
        },
        ...(input.source === undefined
          ? {}
          : {
              validateAdmission: (observation: import("../git/observe.js").GitDecisionObservation) => {
                const current = observation.decision.get(input.source!.contractId);
                return current !== null &&
                  current !== undefined &&
                  current.head === input.source!.head &&
                  current.coordinates.start === input.source!.start &&
                  current.terms.document.key === input.source!.document
                  ? undefined
                  : ({ kind: "fork-source-moved", contractId: input.source!.contractId } as const);
              },
            }),
        ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
      },
    ),
    { contractId: id },
  );
}
