import {
  captureLocalContractComposition,
  type Keiyaku as KeiyakuType,
  type LocalContractComposition,
} from "./contract.js";
import { composeLibrary } from "./composition.js";
import { libraryExecutionInput, localExecutionContext, type LibraryExecution } from "../akuma/requests.js";

export { AuthorityCorruptionError } from "../core/facts/errors.js";
export { Delivery, KeiyakuRefused, KeiyakuRetry } from "./contract.js";
export { projectMutationFinality } from "./contract.js";
export { NoGitWorldError, Repo } from "./repo.js";
export { gatesFrom, requireBranchesToBeUpToDateFrom, SettingsError, worktreeHooksFrom } from "./configuration.js";
export { AkumaWorldScopeError } from "./address.js";
export { bodyRequestExecution } from "../akuma/requests.js";
export type { LibraryExecution } from "../akuma/requests.js";
export type { LocalContractComposition } from "./contract.js";

export type {
  AbandonInput,
  ActorId,
  AmendInput,
  AmendResult,
  ArcInput,
  AttestationVerdict,
  AuditInput,
  AuditReport,
  DeliveryPreparationRefusal,
  BindInput,
  BindResult,
  AfterEndpointObservation,
  ContractAfterEdge,
  ContractBoard,
  ContractDependent,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractHistory,
  ContractHistoryEvent,
  ContractListInput,
  ContractObservation,
  ContractObservationInput,
  ContractPhase,
  ContractRow,
  ContractWorkspaceObservation,
  ContinuationReport,
  DeliverInput,
  Fact,
  IntegrationConflictMaterialized,
  FactKind,
  KeiyakuOfInput,
  KeiyakuRefusal,
  KeiyakuRetryReason,
  Lag,
  MutationResult,
  MutationFinality,
  MutationFinalityInput,
  MutationFinalitySurface,
  MutationPendingSurface,
  PlacementStop,
  ReconcileReport,
  Review,
  ReviewInput,
  TaskId,
  TopologyEffect,
  VerificationReuse,
  VerificationStop,
} from "./contract.js";
export type { ContractId, ContractState, ChangeId, SnapshotId } from "../core/facts/types.js";
export type {
  Gate,
  GatesFromInput,
  HookCommand,
  RequireBranchesToBeUpToDateFromInput,
  WorktreeHooks,
} from "./configuration.js";
export type { RegionOverlap } from "./region.js";
export type { ReconcileInput, RepoAtInput, RepoReconcileReport } from "./repo.js";
export type { SettlementAction, SettlementLag, SettlementReport } from "../settlement/settle.js";
export type {
  AliasStage,
  AkumaStatus,
  CallObservation,
  CallInput,
  CallResult,
  DispatchStage,
  ForkInput,
  ForkResult,
  IntegrationFailure,
} from "./akuma-creation.js";
export type { AliasBinding } from "../alias/index.js";
export type { Dispatch, DispatchFailure } from "../dispatch/index.js";
export type { AkumaAlias } from "../identity/selector.js";
export type { AkumaGlob } from "../identity/selector.js";
export type { AkuId } from "../akuma/identity.js";
export type { TellResult, TellWake } from "./fleet.js";
export type { AllowedAction, AllowedActions } from "../akuma/allowed.js";
export type { Catalog, CatalogInput, CatalogQuery } from "./catalog.js";
export type { NukeInput, NukeResult } from "./nuke.js";
export type { NukeConfirmationRefusal, NukeConfirmationRequiredRefusal } from "./refusal.js";
export type {
  AkumaAddressInput,
  AkumaSetAddressInput,
  AkumaWorldScopeRefusal,
  DirectAkumaSelector,
  SetAkumaSelector,
} from "./address.js";
export type {
  CreatedTaskObservation,
  DispatchAssociation,
  AkumaKillResult,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellResult,
  AkumaUnobserved,
  AkumaWaitResult,
} from "./fleet.js";
export type {
  AkumaHistoryInput,
  AkumaHistoryResult,
  AkumaInterruptInput,
  AkumaInterruptResult,
  AkumaTellInput,
  AkumaWaitInput,
} from "./fleet.js";

export type Keiyaku = KeiyakuType;
export type KeiyakuLibrary = ReturnType<typeof composeLibrary>;

function routedLibrary(input: Readonly<{ execution: LibraryExecution }>): KeiyakuLibrary {
  return composeLibrary(libraryExecutionInput(input));
}

function localLibrary(input?: LocalContractComposition): KeiyakuLibrary {
  return composeLibrary(localExecutionContext(), captureLocalContractComposition(input));
}

export const Keiyaku = Object.freeze({
  ...composeLibrary(),
  withExecution: routedLibrary,
  withLocal: localLibrary,
});

export { executionReceipt } from "./execution-result.js";
export type { ExecutionCleanup, ExecutionStop, ExecutionReceipt, MutationOperation } from "./execution-result.js";
