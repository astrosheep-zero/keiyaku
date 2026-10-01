/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { AuthorityCorruptionError } from "./core/facts/errors.js";
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { Delivery } from "./library/delivery.js";
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { Keiyaku } from "./library/keiyaku.js";
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { KeiyakuError } from "./library/outcome.js";
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { NoGitWorldError, Repo } from "./library/repo.js";
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { actorId } from "./core/facts/types.js";
/**
 * The package root: the curated Contract, Akuma, Akumas, Task, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { z } from "zod";
export {
  ALLOWED_ACTIONS,
  Akuma,
  AkumaBusyError,
  AkumaDecodeError,
  AkumaNotBornError,
  AkumaProviderError,
  Schema,
} from "./akuma/index.js";
export type {
  ActivityHistory,
  ActivityRow,
  AkuId,
  AkumaAskObservation,
  AkumaAskOptions,
  AkumaAskResult,
  AkumaBirthInput,
  AkumaHistoryOptions,
  AkumaIdleOptions,
  AkumaIdleResult,
  AkumaSignalOptions,
  AkumaStatus,
  AkumaTellOptions,
  AkumaTellResult,
  AllowedAction,
  AllowedActions,
  InterruptReceipt,
  JsonSchema,
  JsonSchemaDocument,
  KillEvidence,
  SchemaLike,
  StandardSchemaV1,
} from "./akuma/index.js";
export type {
  ActorId,
  ChangeId,
  ContractHead,
  ContractId,
  ContractState,
  JournalEntry as Fact,
  FactKind,
  SnapshotId,
} from "./core/facts/types.js";
export { kanshi, observeKanshi, selectKanshi, selectRegion } from "./kanshi/index.js";
export type {
  AkumaKanshiRow,
  AkumaKanshiWorld,
  ContractEndpointObservation,
  ContractHolderObservation,
  ContractKanshiBoard,
  ContractKanshiRow,
  KanshiInput,
  KanshiRegionSelection,
  KanshiReport,
  KanshiSelection,
  RegionDeclaration,
  RegionRead,
  Section,
  TaskKanshiRow,
  TaskKanshiWorld,
} from "./kanshi/index.js";
export { AkumaAddressError, AkumaWorldScopeError, Akumas } from "./library/akumas.js";
export type {
  AkumaAddressInput,
  AkumaAskInput,
  AkumaHistoryInput,
  AkumaHistoryResult,
  AkumaKillInput,
  AkumaKillResult,
  AkumaList,
  AkumaListInput,
  AkumaObservation,
  AkumaObservationStage,
  AkumaTellInput,
  AkumaWaitInput,
  AkumaWaitResult,
  AkumaWorldScopeRefusal,
  CallInput,
  CallResult,
  CallWaitHead,
  CreatedTaskObservation,
  DispatchAssociation,
  DispatchStage,
  ForkInput,
  ForkResult,
  TellResult,
  TellWake,
  WaitObservedAkuma,
  WaitObserver,
  WaitSelectedAkuma,
} from "./library/akumas.js";
export type { ContinuationReport } from "./library/continuation.js";
export type { KeiyakuLibrary, ReconcileInput } from "./library/contract-composition.js";
export type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  AuditOutcome,
  BindOutcome,
  BindResult,
  DeliverOutcome,
  ReviewOutcome,
} from "./library/contract-outcomes.js";
export type {
  AbandonInput,
  AmendInput,
  ArcInput,
  BindInput,
  ContractHistory,
  ContractHistoryEvent,
  ContractList,
  ContractListInput,
  ContractObservationInput,
  DeliverInput,
  KeiyakuSelectInput,
  LocalContractComposition,
  ReviewInput,
} from "./library/contract-types.js";
export { nukeKeiyaku as nuke } from "./library/nuke.js";
export type { NukeInput, NukeResult } from "./library/nuke.js";
export type {
  InvocationEffect,
  KeiyakuErrorCategory,
  PartialOutcomeEnvelope,
  PendingSurface,
  ReconciliationLag,
  Review,
} from "./library/outcome.js";
export type { ReconcileCompletion, RepoContractReconcileReport, RepoReconcileReport } from "./library/reconcile.js";
export type {
  KeiyakuRefusal,
  KeiyakuRetryReason,
  NukeConfirmationRefusal,
  NukeConfirmationRequiredRefusal,
  OperationRetries,
} from "./library/refusal.js";
export type { RegionOverlap } from "./library/region.js";
export type { RepoAtInput } from "./library/repo.js";
export type {
  KeiyakuPlugin,
  PluginBodyEnd,
  PluginContext,
  PluginHooks,
  PluginInstance,
  PluginManifest,
  PluginOutcome,
  PluginSignal,
  PluginSignalMap,
} from "./plugin/public.js";
export type { AuditReport } from "./protocol/audit.js";
export type { IntegrationConflictMaterialized, VerificationReuse } from "./protocol/deliver.js";
export type { ExecutionObservation, ExecutionObserver } from "./protocol/execution-observation.js";
export type { PlacementStop, VerificationStop } from "./protocol/operations.js";
export type { ExecutionCleanup, ExecutionStop } from "./protocol/progress.js";
export type {
  ContractAfterEdge,
  ContractBoard,
  ContractCatalogue,
  ContractDependent,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractObservation,
  ContractPhase,
  ContractRow,
  ContractWorkspaceObservation,
} from "./protocol/read/status.js";
export { SettingsError, settings } from "./settings.js";
export type { Gate } from "./library/contract-types.js";
export type {
  Settings,
  SettingsEntry,
  SettingsInput,
  SettingsNamespaceFailure,
  SettingsNamespaceView,
  SettingsScope,
  SettingsScopeState,
} from "./settings.js";
export type { SettlementAction, SettlementLag, SettlementReport } from "./settlement/settle.js";
export type * from "./task/index.js";
export { TASK_RELATION_PREDICATE_FIELDS, TaskAuthorityCorruptionError, Tasks } from "./task/index.js";
export { World, WorldError } from "./world.js";
export type { WorldResolution, WorldResolutionInput, WorldRoot } from "./world.js";

export type { ReconcileReport, TopologyEffect } from "./library/reconcile.js";
