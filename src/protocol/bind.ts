import { z } from "zod";
import { contractId, type ActorId, type BindData, type ContractId } from "../core/facts/types.js";
import {
  resolveContractTarget,
  targetRef,
  targetWorkspaceRefusalSchema,
  type TargetWorkspaceRefusal,
} from "../git/target.js";
import { acquireTargetPlacementFence } from "../git/target-placement.js";
import { decideBind, type BindInput, type BindRefusal } from "../core/verbs/bind.js";
import { gitObjectIdForSnapshot } from "../git/identity.js";
import {
  normalizeTargetBranch,
  observeBindCoordinates,
  type BindCoordinatesObservation,
  type BindTargetSelection,
} from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import {
  VERIFIED,
  type VerificationDeclarationPreparation,
  type VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitPreparedIntent } from "./intent.js";
import { complete, type IntentOutcome } from "./outcome.js";
import type { CompanionDecorator, ExternalProtocolPreparation, InCustodyProtocolPreparation } from "./run.js";

export type { BindRefusal } from "../core/verbs/bind.js";
export type { BindTargetSelection };
export const targetInputRefusalSchema = z.union([
  z
    .object({ kind: z.enum(["invalid-target", "target-missing", "unborn-head"]) })
    .strict()
    .readonly(),
  targetWorkspaceRefusalSchema,
]);
type TargetInputRefusal = z.infer<typeof targetInputRefusalSchema>;
export const forkSourceMovedRefusalSchema = z
  .object({ kind: z.literal("fork-source-moved") })
  .strict()
  .readonly();
type ForkSourceMovedRefusal = z.infer<typeof forkSourceMovedRefusalSchema>;

type BindOperationInput = Readonly<{
  scope: GitRepository;
  channel: GitDecodeChannel;
  terms: BindData["terms"];
  verification: VerificationDeclarationPreparation;
  targetSelection: BindTargetSelection;
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

type BindRefusalUnion =
  | BindRefusal
  | TargetInputRefusal
  | VerificationDeclarationRefusal
  | ForkSourceMovedRefusal
  | TargetWorkspaceRefusal;
type BindSeed = Readonly<{ contractId: ContractId; actor?: ActorId; at: string }>;
type RefusedVerificationDeclaration = Extract<VerificationDeclarationPreparation, Readonly<{ kind: "refused" }>>;

/** What one seat-external coordinate acquisition proves about the mutable Git coordinates. */
type BindCoordinatesPreparation =
  | Readonly<{ kind: "resolved"; observed: BindCoordinatesObservation }>
  | Readonly<{ kind: "unresolved"; reason: "target-missing" | "unborn-head" }>
  | Readonly<{ kind: "target-refused"; refusal: TargetWorkspaceRefusal }>
  | Readonly<{ kind: "declaration-refused"; preparation: RefusedVerificationDeclaration }>;

/**
 * Acquire the repeatable Git coordinates outside the publication seat. The artifact carries the
 * observed start/target plus the expected ref assertions that publication must still confirm.
 */
async function prepareBindCoordinates(
  input: BindOperationInput,
  selection: BindTargetSelection,
): Promise<ExternalProtocolPreparation<BindCoordinatesPreparation, BindRefusalUnion>> {
  if (input.terms.gates.includes(VERIFIED) && input.verification.kind === "refused") {
    return { kind: "prepared", prepared: { kind: "declaration-refused", preparation: input.verification } };
  }
  if (selection.kind === "contract") {
    const resolved = await resolveContractTarget(input.scope, selection.contractId, selection.inherited);
    if (resolved.kind === "refused")
      return { kind: "prepared", prepared: { kind: "target-refused", refusal: resolved.refusal } };
    const observed: BindCoordinatesObservation = { start: resolved.head, target: resolved.target, branch: null };
    return {
      kind: "prepared",
      prepared: { kind: "resolved", observed },
      assertions: [{ ref: targetRef(resolved.target), oid: gitObjectIdForSnapshot(resolved.head) }],
    };
  }
  const observed = await observeBindCoordinates(input.scope, selection);
  if (observed === null) return { kind: "prepared", prepared: { kind: "unresolved", reason: "target-missing" } };
  if ("kind" in observed) return { kind: "prepared", prepared: { kind: "unresolved", reason: "unborn-head" } };
  return {
    kind: "prepared",
    prepared: { kind: "resolved", observed },
    ...(input.coordinates === undefined
      ? {
          assertions: [
            {
              ref: observed.target === undefined ? "HEAD" : targetRef(observed.target),
              oid: gitObjectIdForSnapshot(observed.start),
            },
          ],
        }
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
): Promise<
  InCustodyProtocolPreparation<BindInput<VerificationDeclarationRefusal | TargetWorkspaceRefusal>, BindRefusalUnion>
> {
  const targetContract = selection.kind === "contract" ? selection.contractId : undefined;
  const targetInput = targetContract === undefined ? {} : { targetContract };
  if (prepared.kind === "declaration-refused") {
    return { kind: "prepared", input: { ...seed, ...targetInput, preparation: prepared.preparation } };
  }
  if (prepared.kind === "target-refused") {
    return {
      kind: "prepared",
      input: { ...seed, ...targetInput, preparation: { kind: "refused", refusal: prepared.refusal } },
    };
  }
  if (prepared.kind === "unresolved") {
    if (selection.kind === "contract") return { kind: "stale" };
    const current = await observeBindCoordinates(input.scope, selection);
    if (current === null) return { kind: "refused", refusal: { kind: "target-missing" } };
    if ("kind" in current) return { kind: "refused", refusal: { kind: "unborn-head" } };
    return { kind: "stale" };
  }
  const observed = prepared.observed;
  if (selection.kind === "contract") {
    const expected = observed.target;
    if (expected === undefined || typeof expected === "string") throw new Error("missing prepared Contract target");
    const current = await resolveContractTarget(input.scope, selection.contractId, expected);
    if (current.kind === "refused")
      return {
        kind: "prepared",
        input: { ...seed, ...targetInput, preparation: { kind: "refused", refusal: current.refusal } },
      };
    if (current.head !== observed.start) return { kind: "stale" };
  }
  return {
    kind: "prepared",
    input: {
      ...seed,
      ...targetInput,
      preparation: {
        kind: "prepared",
        data: {
          coordinates: {
            start: input.coordinates?.start ?? observed.start,
            ...(observed.target === undefined ? {} : { target: observed.target }),
            workspace: "worktree",
          },
          terms: input.terms,
        },
      },
    },
  };
}

export async function bindOperation(
  input: BindOperationInput,
): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusalUnion>> {
  let selection: BindTargetSelection = input.targetSelection;
  if (selection.kind === "explicit") {
    if (selection.target.startsWith("kei/")) {
      try {
        selection = { kind: "contract", contractId: contractId(selection.target) };
      } catch {
        return { kind: "refused", refusal: { kind: "invalid-target" } };
      }
    } else {
      const normalized = await normalizeTargetBranch(input.scope, selection.target);
      if (normalized === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
      selection = { kind: "explicit", target: normalized };
    }
  }
  const at = new Date().toISOString();
  const id = input.contractId;
  const incoming =
    selection.kind === "contract" ? await acquireTargetPlacementFence(input.scope, selection.contractId) : undefined;
  try {
    return complete(
      await admitPreparedIntent<
        BindInput<VerificationDeclarationRefusal | TargetWorkspaceRefusal>,
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
          observedContracts: [
            id,
            ...input.terms.after,
            ...(selection.kind === "contract" ? [selection.contractId] : []),
            ...(input.source === undefined ? [] : [input.source.contractId]),
          ],
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
                    : ({ kind: "fork-source-moved" } as const);
                },
              }),
          ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
        },
      ),
      { contractId: id },
    );
  } finally {
    incoming?.close();
  }
}
