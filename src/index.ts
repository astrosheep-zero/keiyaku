/**
 * The package root exposes native products and named domain types.
 * Validators and private construction, execution, and storage stay with owners.
 */
export { AkumaHost } from "./body-host.js";
export type { AkumaHostScope } from "./body-host.js";
export { AuthorityCorruptionError } from "./core/facts/errors.js";
export { Kei } from "./library/kei.js";
export type { Guidance } from "./library/kei.js";
export type { Delivery } from "./library/delivery.js";
export { Keiyaku, KeiyakuArcDocumentError, KeiyakuUsageError } from "./library/keiyaku.js";
export type { KeiyakuAt } from "./library/keiyaku.js";
export type {
  KeiyakuRunOptions,
  VerbEntry,
  VerbName,
  VerbInput,
  VerbOutput,
  VerbProgress,
  VerbRun,
  VerbRunFor,
  VerbDisposition,
  VerbCompletion,
} from "./library/keiyaku-verbs.js";
export { Keis } from "./library/contract-composition.js";
export type { KeisReconcile, ReconcileInput } from "./library/contract-composition.js";
export { KeiyakuError } from "./errors.js";
export type { KeiyakuErrorCategory, KeiyakuErrorOptions } from "./errors.js";
export { NoGitWorldError, Repo } from "./library/repo.js";
export {
  Akuma,
  AkumaArchetypeError,
  AkumaBusyError,
  AkumaDecodeError,
  AkumaNotBornError,
  AkumaObservationError,
  AkumaProviderError,
} from "./akuma/index.js";
export type {
  AkumaCaller,
  AkumaOrigin,
  ActivityHistory,
  ActivityRow,
  ActivitySnapshot,
  AkumaId,
  AkumaAskObservation,
  AkumaAskOptions,
  AkumaAskResult,
  AkumaBirthInput,
  AkumaHistoryOptions,
  AkumaHostOptions,
  AkumaIdleOptions,
  AkumaIdleResult,
  AkumaReportOptions,
  AkumaReportResult,
  AkumaRosterInput,
  AkumaSignalOptions,
  AkumaStatus,
  AkumaStreamSnapshot,
  AkumaTellOptions,
  AkumaTellResult,
  ArchetypeCatalog,
  ArchetypeCatalogInput,
  ArchetypeCatalogRow,
  JsonSchema,
  JsonSchemaDocument,
  KillEvidence,
} from "./akuma/index.js";
export type { AskObserver, AskProgress } from "./akuma/akuma-selection-execution.js";
export type { LiveStatusObservation } from "./akuma/akuma-observe.js";
export type { TellResult, TellWake } from "./akuma/call-initial-tell.js";
export type { AkumaAlias } from "./identity/selector.js";
export type { AkumaAddressRefusal, AkumaSetAddressInput } from "./library/address.js";
export type { SpawnProgress, SpawnWaitObserver } from "./library/akuma-creation.js";
export type { WhoamiFacts } from "./library/keiyaku-identity.js";
export type {
  ChangeId,
  ContractHead,
  ContractId,
  ContractState,
  ContractTarget,
  JournalEntry as Fact,
  FactKind,
  SnapshotId,
} from "./core/facts/types.js";
export { Kanshi } from "./kanshi/index.js";
export type {
  KanshiScopeInput,
  KanshiBoardOptions,
  KanshiCountsReport,
  AkumaKanshiRow,
  AkumaKanshiWorld,
  ContractEndpointObservation,
  ContractHolderObservation,
  ContractKanshiBoard,
  ContractKanshiDetail,
  KanshiContractReport,
  KanshiResult,
  KanshiRegionSelection,
  KanshiReport,
  RegionDeclaration,
  RegionRead,
  Section,
  DebtKanshiRow,
  DebtKanshiWorld,
} from "./kanshi/index.js";
export { AkumaAddressError, AkumaWorldScopeError, Akumas } from "./library/akumas.js";
export type {
  AliasBinding,
  AkumaAddressInput,
  AkumaArchetypesInput,
  AkumaAliasesInput,
  AkumaAskInput,
  AkumaHistoryInput,
  AkumaHistoryResult,
  AkumaKillInput,
  AkumaKillResult,
  AkumaList,
  AkumaListInput,
  AkumaObservation,
  AkumaTellInput,
  AkumaWaitInput,
  AkumaWaitResult,
  AkumaWorldScopeRefusal,
  DispatchAssociation,
  ForkInput,
  ForkResult,
  SpawnInput,
  SpawnResult,
  SpawnWaitHead,
} from "./library/akumas.js";
export type { ContinuationReport } from "./library/continuation.js";
export type {
  ContractWaitInput,
  ContractWaitOptions,
  ContractWaitMember,
  ContractWaitResult,
} from "./library/contract-wait.js";
export type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  DeliveryPreviewInput,
  DeliveryPreviewOutcome,
  BindOutcome,
  DeliverOutcome,
  MutationObservation,
  ReviewOutcome,
  VerifyOutcome,
} from "./library/contract-outcomes.js";
export type {
  AbandonInput,
  AmendInput,
  ArcInput,
  BindInput,
  ContractHistory,
  ContractHistoryInput,
  ContractHistoryEvent,
  ContractList,
  ContractListInput,
  ContractObservationInput,
  ContractResolveInput,
  ContractResolution,
  ContractSelectorRefusal,
  DeliverInput,
  KeisOptions,
  ReviewInput,
  VerifyInput,
  Gate,
} from "./library/contract-types.js";
export { nukeKeiyaku as nuke } from "./library/nuke.js";
export type { NukeInput, NukeResult } from "./library/nuke.js";
export type {
  InvocationIssue,
  ResetCounts,
  ResetIssue,
  PartialOutcomeEnvelope,
  HandoffOutcome,
  ReconciliationLag,
  Review,
  Verify,
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
  PluginAkumaCaller,
  PluginAkumaOrigin,
  PluginBodyEnd,
  PluginContext,
  PluginHooks,
  PluginInstance,
  PluginManifest,
  PluginOutcome,
  PluginWaitDeferral,
  PluginWaitDeferralInput,
  PluginSignal,
  PluginSignalMap,
} from "./plugin/public.js";
export type { VerifyValue, VerificationCheck, VerificationStop } from "./protocol/verify.js";
export type { Placement, Placed, RequirementProblem } from "./protocol/completion.js";
export type { DeliveryPreviewReport } from "./protocol/delivery-preview.js";
export type { ExecutionObservation, ExecutionObserver } from "./protocol/execution-observation.js";
export type { ExecutionStop } from "./protocol/progress.js";
export type {
  ContractAfterEdge,
  ContractCatalogue,
  ContractSummary,
  ContractDetail,
  ContractDetailWorkspace,
  ContractGateCurrent,
  ContractGateReport,
  ContractObservation,
  ContractPhase,
} from "./protocol/read/status.js";
export { SettingsError, Settings } from "./settings.js";
export type {
  SettingsEntry,
  SettingsInput,
  SettingsNamespaceFailure,
  SettingsNamespaceView,
  SettingsScope,
  SettingsScopeState,
} from "./settings.js";
export type { SettlementAction, SettlementLag, SettlementReport } from "./settlement/settle.js";
export { DebtAuthorityCorruptionError, Debts } from "./debt/index.js";
export type {
  AddDebtDocumentInput,
  AddDebtInput,
  BlockedDebtList,
  BlockedDebtRow,
  Debt,
  DebtAbsent,
  DebtCatalogue,
  DebtChange,
  DebtDetail,
  DebtDoctorIssue,
  DebtDoctorReport,
  DebtId,
  DebtList,
  DebtMutationResult,
  DebtParentReadRefusal,
  DebtPriority,
  DebtReadPage,
  DebtReadResult,
  DebtReadyList,
  DebtRef,
  DebtRefusal,
  DebtRetry,
  DebtShowItem,
  DebtShowResult,
  DebtState,
  DebtSummary,
  DebtTreeNode,
  DebtTreeResult,
  DebtTreeRoot,
  DebtUpdateResult,
  DebtWarning,
  ReadyDebtRow,
  UpdateDebtInput,
} from "./debt/index.js";
export { World, WorldError } from "./world.js";
export type { WorldInput, WorldResolution, WorldResolutionInput, WorldRoot } from "./world.js";
