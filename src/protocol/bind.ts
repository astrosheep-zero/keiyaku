import { z } from "zod";
import { contractState } from "../core/facts/observation.js";
import type { BindData, ContractHead, ContractId, ContractTarget, SnapshotId } from "../core/facts/types.js";
import { decideBind, type BindInput, type BindRefusal } from "../core/verbs/bind.js";
import { gitObjectIdForSnapshot } from "../git/identity.js";
import {
  observeBindCoordinates,
  observeContractsAt,
  selectExplicitTarget,
  type BindTargetSelection,
} from "../git/observe.js";
import type { GitRepository } from "../git/process.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import {
  resolveContractTarget,
  targetRef,
  targetWorkspaceRefusalSchema,
  type TargetWorkspaceRefusal,
} from "../git/target.js";
import { acquireTargetPlacementFence } from "../git/target-placement.js";
import {
  VERIFIED,
  type VerificationDeclarationPreparation,
  type VerificationDeclarationRefusal,
} from "../verification/declaration.js";
import { admitIntent, type IntentAdmissionOptions } from "./intent.js";
import { complete, type IntentOutcome } from "./outcome.js";
import { mintAttempts, type AcceptedAdmission } from "./attempt.js";
import { runBoundedAttempts, type ObservedRef } from "./run.js";
import type { CompanionDecorator } from "./run.js";
import type { ProtocolProgress } from "./progress.js";

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
  decorateOffer?: CompanionDecorator;
  progress?: ProtocolProgress;
  contractId: ContractId;
  coordinates?: Readonly<{ start: SnapshotId }>;
  source?: Readonly<{
    contractId: ContractId;
    head: import("../core/facts/types.js").ContractHead | null;
    start: SnapshotId;
    document: import("../core/facts/types.js").DocumentKey;
  }>;
}>;

type BindFailure = TargetInputRefusal | VerificationDeclarationRefusal | ForkSourceMovedRefusal;
type BindPreparation = BindInput<BindFailure>["preparation"];
type PreparedBind = Readonly<{
  preparation: BindPreparation;
  expectedHead: ContractHead | null;
  expectedRef?: ObservedRef;
}>;

async function prepareBind(
  input: BindOperationInput,
  selection: BindTargetSelection,
): Promise<Readonly<{ preparation: BindPreparation; expectedRef?: ObservedRef }>> {
  if (input.terms.gates.includes(VERIFIED) && input.verification.kind === "refused") {
    return { preparation: input.verification };
  }
  const fixedStart = input.coordinates?.start;
  let start: SnapshotId;
  let target: ContractTarget | undefined;
  if (selection.kind === "contract") {
    const resolved = await resolveContractTarget(input.scope, selection.contractId, selection.inherited);
    if (resolved.kind === "refused") return { preparation: resolved };
    ({ start, target } = { start: resolved.head, target: resolved.target });
  } else if (selection.kind === "targetless" && fixedStart !== undefined) {
    start = fixedStart;
  } else {
    const observed = await observeBindCoordinates(input.scope, selection);
    if (observed === null) {
      if (selection.kind !== "explicit") throw new Error("missing bind coordinates without an explicit target");
      return {
        preparation: { kind: "refused", refusal: { kind: "target-missing" } },
        expectedRef: { ref: selection.target, oid: null },
      };
    }
    if ("kind" in observed) {
      return {
        preparation: { kind: "refused", refusal: { kind: "unborn-head" } },
        expectedRef: { ref: "HEAD", oid: null },
      };
    }
    ({ start, target } = observed);
  }
  const expectedRef =
    target !== undefined || fixedStart === undefined
      ? { ref: target === undefined ? "HEAD" : targetRef(target), oid: gitObjectIdForSnapshot(start) }
      : undefined;
  return {
    preparation: {
      kind: "prepared",
      data: {
        terms: input.terms,
        coordinates: { start: fixedStart ?? start, workspace: "worktree", ...(target === undefined ? {} : { target }) },
      },
    },
    ...(expectedRef === undefined ? {} : { expectedRef }),
  };
}

export async function bindOperation(
  input: BindOperationInput,
): Promise<IntentOutcome<Readonly<{ contractId: ContractId }>, BindRefusal | BindFailure>> {
  const selection =
    input.targetSelection.kind === "explicit"
      ? await selectExplicitTarget(input.scope, input.targetSelection.target)
      : input.targetSelection;
  if (selection === null) return { kind: "refused", refusal: { kind: "invalid-target" } };
  const { scope, channel, contractId, source } = input;
  const targetContract = selection.kind === "contract" ? selection.contractId : undefined;
  const incoming = targetContract === undefined ? undefined : await acquireTargetPlacementFence(scope, targetContract);
  try {
    const result = await runBoundedAttempts<PreparedBind, AcceptedAdmission, BindRefusal | BindFailure>(
      mintAttempts({ entryCount: 1 }),
      async () => {
        const before = await observeContractsAt(scope, channel, [contractId]);
        const expectedHead = contractState(before.decision, contractId)?.head ?? null;
        const { preparation, expectedRef } = await prepareBind(input, selection);
        return {
          kind: "prepared",
          prepared: { preparation, expectedHead, ...(expectedRef === undefined ? {} : { expectedRef }) },
        };
      },
      async (prepared, attempt) => {
        const { preparation, expectedHead, expectedRef } = prepared;
        const target = preparation.kind === "prepared" ? preparation.data.coordinates.target : undefined;
        const validateAdmission: NonNullable<IntentAdmissionOptions<BindFailure>["validateAdmission"]> = async (
          observation,
        ) => {
          if (source !== undefined) {
            const current = contractState(observation.decision, source.contractId);
            if (
              current === null ||
              current.head !== source.head ||
              current.coordinates.start !== source.start ||
              current.terms.document.key !== source.document
            )
              return { kind: "fork-source-moved" };
          }
          if (target !== undefined && typeof target !== "string") {
            const resolved = await resolveContractTarget(scope, target.contractId, target);
            if (resolved.kind === "refused") return resolved.refusal satisfies TargetWorkspaceRefusal;
          }
          return undefined;
        };
        return await admitIntent(
          channel,
          scope,
          {
            contractId,
            at: new Date().toISOString(),
            preparation,
            ...(targetContract === undefined ? {} : { targetContract }),
          },
          decideBind,
          {
            attempt,
            expectedHead,
            ...(expectedRef === undefined ? {} : { expectedRef }),
            observedContracts: [
              contractId,
              ...input.terms.after,
              ...(targetContract === undefined ? [] : [targetContract]),
              ...(source === undefined ? [] : [source.contractId]),
            ],
            validateAdmission,
            ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
            ...(input.progress === undefined ? {} : { progress: input.progress }),
          },
        );
      },
    );
    return complete(result, { contractId });
  } finally {
    incoming?.close();
  }
}
