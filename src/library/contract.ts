// Contract's static facade deliberately depends only on construction and observation.
import { actorOption, optionalBoolean, requireInput } from "./input.js";
import { worktreeHooksOption } from "./configuration.js";
import type { RegionOverlap } from "./region.js";
import {
  contractId,
  type ChangeId,
  type FactKind,
  type ContractId,
  type ContractState,
  type SnapshotId,
} from "../core/facts/types.js";
export { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  contractCatalogueOperation,
  contractObservationOperation,
  contractsOperation,
  type PlacementStop,
  type VerificationStop,
  type DeliveryPreparationRefusal,
} from "../protocol/operations.js";
import type {
  ContractBoard,
  ContractCatalogue,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractObservation,
  ContractPhase,
  ContractRow,
  AfterEndpointObservation,
  ContractAfterEdge,
  ContractDependent,
  ContractWorkspaceObservation,
} from "../protocol/read/status.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized, VerificationReuse } from "../protocol/deliver.js";
import { withGitDecodeChannel } from "../git/read-observation.js";
import type { TaskId } from "../task/identity.js";
import { scopeForRepo, type Repo } from "./repo.js";
import { localExecutionContext, type ExecutionContext } from "../akuma/requests.js";
import type { AuditInput } from "./audit.js";
import { Delivery } from "./delivery.js";
import { type ContinuationReport } from "./continuation.js";
import type { MutationResult } from "./mutation.js";
export { projectMutationFinality } from "./mutation.js";
export type { MutationFinality, MutationFinalityInput, MutationFinalitySurface } from "./mutation.js";
import { bindFromCli as bindFromCliImplementation, bindKeiyaku as bindKeiyakuImplementation } from "./contract-bind.js";
export { KeiyakuHandle } from "./contract-handle.js";
import { KeiyakuHandle } from "./contract-handle.js";
import type {
  AbandonInput,
  AmendInput,
  AmendResult,
  ArcInput,
  BindInput,
  BindResult,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  ForkBindInput,
  KeiyakuOfInput,
  LocalContractComposition,
  MarkdownBindInput,
  ReconcileReport,
  ReviewInput,
  ContractHistory,
  ContractHistoryEvent,
  Fact,
  Lag,
  TopologyEffect,
} from "./contract-types.js";
import type {
  AttestationVerdict as OperationAttestationVerdict,
  Review as OperationReview,
} from "./contract-operations.js";
import { KeiyakuRetry, type KeiyakuRefusal, type KeiyakuRetryReason } from "./refusal.js";
export { KeiyakuRefused } from "./refusal.js";
export { KeiyakuRetry, type KeiyakuRefusal, type KeiyakuRetryReason };
export { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError } from "./configuration.js";
export type {
  Gate,
  GatesFromInput,
  HookCommand,
  RequireBranchesToBeUpToDateFromInput,
  WorktreeHooks,
} from "./configuration.js";

export type {
  AbandonInput,
  AmendInput,
  AmendResult,
  ArcInput,
  AuditInput,
  AuditReport,
  ChangeId,
  ContinuationReport,
  ContractBoard,
  ContractCatalogue,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractAfterEdge,
  ContractId,
  ContractHistory,
  ContractHistoryEvent,
  ContractDependent,
  ContractObservation,
  ContractPhase,
  ContractRow,
  ContractState,
  ContractWorkspaceObservation,
  BindInput,
  BindResult,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  ForkBindInput,
  KeiyakuOfInput,
  MarkdownBindInput,
  ReconcileReport,
  ReviewInput,
  DeliveryPreparationRefusal,
  Fact,
  FactKind,
  IntegrationConflictMaterialized,
  Lag,
  LocalContractComposition,
  MutationResult,
  PlacementStop,
  RegionOverlap,
  SnapshotId,
  TaskId,
  TopologyEffect,
  VerificationReuse,
  VerificationStop,
};
export type { AfterEndpointObservation };

export type ActorId = string;
export type AttestationVerdict = OperationAttestationVerdict;
export type Review = OperationReview;

export { Delivery };

export type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";

export type Keiyaku = KeiyakuHandle;
export type LocalContractCompositionCapture = Readonly<{
  actor?: NonNullable<ReturnType<typeof actorOption>["actor"]>;
  hooks: ReturnType<typeof worktreeHooksOption>;
  requireBranchesToBeUpToDate: boolean;
}>;

export function captureLocalContractComposition(input?: LocalContractComposition): LocalContractCompositionCapture {
  const values = requireInput(input ?? {}, "Keiyaku.withLocal input", [
    "actor",
    "hooks",
    "requireBranchesToBeUpToDate",
  ]);
  const actor = actorOption(values.actor).actor;
  return Object.freeze({
    ...(actor === undefined ? {} : { actor }),
    hooks: worktreeHooksOption(values.hooks),
    requireBranchesToBeUpToDate:
      optionalBoolean(values.requireBranchesToBeUpToDate, "Keiyaku.withLocal requireBranchesToBeUpToDate") ?? false,
  });
}

export function keiyakuOf(
  input: KeiyakuOfInput,
  execution: ExecutionContext = localExecutionContext(),
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Keiyaku {
  const values = requireInput(input, "Keiyaku.of input");
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  return new KeiyakuHandle(contractId(values.id), scope, execution, composition);
}

export async function listKeiyaku(input: ContractListInput): Promise<ContractBoard> {
  const values = requireInput(input, "Keiyaku.list input");
  for (const key of Object.keys(values))
    if (key !== "repo") throw new TypeError(`Keiyaku.list input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  return withGitDecodeChannel(scope, (channel) => contractsOperation({ scope, channel }));
}

/** Internal bounded catalogue composition; the public Contract board remains complete. */
export async function listContractCatalogue(
  input: Readonly<{ repo: Repo; limit?: number }>,
): Promise<ContractCatalogue> {
  const values = requireInput(input, "Contract catalogue input");
  for (const key of Object.keys(values)) {
    if (key !== "repo" && key !== "limit") throw new TypeError(`Contract catalogue input has unknown field: ${key}`);
  }
  const limit = values.limit;
  if (limit !== undefined && typeof limit !== "number") {
    throw new TypeError("Contract catalogue limit must be a number");
  }
  const scope = scopeForRepo(values.repo);
  return withGitDecodeChannel(scope, (channel) =>
    contractCatalogueOperation({
      scope,
      channel,
      ...(limit === undefined ? {} : { limit }),
    }),
  );
}

export async function observeKeiyaku(input: ContractObservationInput): Promise<ContractObservation> {
  const values = requireInput(input, "Keiyaku.observe input");
  for (const key of Object.keys(values))
    if (key !== "repo" && key !== "id") throw new TypeError(`Keiyaku.observe input has unknown field: ${key}`);
  const scope = scopeForRepo(values.repo);
  if (typeof values.id !== "string") throw new TypeError("contract ID must be a string");
  let id: ContractId;
  try {
    id = contractId(values.id);
  } catch (error) {
    throw new TypeError(error instanceof Error ? error.message : "contract ID is invalid");
  }
  return withGitDecodeChannel(scope, (channel) => contractObservationOperation({ scope, channel, contractId: id }));
}

export async function bindKeiyaku(
  input: BindInput,
  execution: ExecutionContext = localExecutionContext(),
  composition: LocalContractCompositionCapture = captureLocalContractComposition(),
): Promise<BindResult> {
  return bindKeiyakuImplementation(input, (id, scope) => new KeiyakuHandle(id, scope, execution, composition));
}

export { parseMarkdownBindDocument } from "./contract-bind.js";

/** Internal CLI composition; not exported from the package root. */
export async function bindFromCli(
  input: BindInput,
  execution: ExecutionContext = localExecutionContext(),
): Promise<BindResult> {
  const composition = captureLocalContractComposition();
  return bindFromCliImplementation(input, (id, scope) => new KeiyakuHandle(id, scope, execution, composition));
}
