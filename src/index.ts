/**
 * The package root: the curated Contract, Akuma, Akumas, Debt, Kanshi, World,
 * Settings, and Plugin surfaces. Internal composition, execution, and
 * configuration helpers stay off this entry; only CLI and Body import them.
 */
export { akumaListSchema, akumaStatusSchema } from "./akuma/akuma.js";
export { activityHistorySchema, activityRowSchema, activitySnapshotSchema, tellRowSchema } from "./akuma/projection.js";
export { akumaCallerSchema } from "./akuma/caller.js";
export { killEvidenceSchema } from "./akuma/heart/facts.js";
export { tellWakeSchema } from "./akuma/call-initial-tell.js";
export { akumaIdleResultSchema, akumaReportResultSchema } from "./akuma/akuma-instance.js";
export { liveStatusObservationSchema, askProgressSchema } from "./akuma/akuma-selection-execution.js";
export type { AskProgress } from "./akuma/akuma-selection-execution.js";
export { archetypeCatalogSchema, archetypeCatalogRowSchema } from "./akuma/archetype.js";
export {
  akumaObservationSchema,
  akumaWaitResultSchema,
  akumaWaitItemSchema,
  akumaKillResultSchema,
  akumaTellResultSchema,
  akumaAskResultSchema,
  akumaAskObservationSchema,
} from "./akuma/selection-observation.js";
export { akumaHistoryResultSchema } from "./library/selection.js";
export {
  spawnResultSchema,
  spawnProgressSchema,
  spawnWaitHeadSchema,
  forkResultSchema,
} from "./library/akuma-creation.js";
export type { SpawnProgress } from "./library/akuma-creation.js";
export { whoamiFactsSchema } from "./library/keiyaku-identity.js";
export type { WhoamiFacts } from "./library/keiyaku-identity.js";
export { dispatchSchema, dispatchFailureSchema } from "./dispatch/index.js";
export { AkumaHost } from "./body-host.js";
export type { AkumaHostScope } from "./body-host.js";
export { AuthorityCorruptionError } from "./core/facts/errors.js";
export { deliverySchema } from "./library/delivery.js";
export type { Delivery } from "./library/delivery.js";
export { Kei, guidanceSchema } from "./library/kei.js";
export type { Guidance } from "./library/kei.js";
export {
  contractResolutionSchema,
  contractSelectorRefusalSchema,
  contractHistorySchema,
  contractHistoryEventSchema,
} from "./library/contract-types.js";
export { Keiyaku, KeiyakuUsageError } from "./library/keiyaku.js";
export type {
  KeiyakuAt,
  DebtSelection,
  DebtReadScope,
  DebtLsInvocation,
  DebtQueryInvocation,
  DebtUpdateInvocation,
  DebtCloseInvocation,
  DebtShowInvocation,
} from "./library/keiyaku.js";
export { classifyVerb } from "./library/keiyaku-verbs.js";
export type {
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
export { KeiyakuError, projectFailure } from "./library/outcome.js";
export { NoGitWorldError, Repo } from "./library/repo.js";
export { actorId } from "./core/facts/types.js";
export { z } from "zod";
export {
  Akuma,
  AkumaArchetypeError,
  AkumaBusyError,
  AkumaDecodeError,
  AkumaNotBornError,
  AkumaProviderError,
  listArchetypeDefinitions,
} from "./akuma/index.js";
export type {
  AkumaCaller,
  AkumaOrigin,
  ActivityHistory,
  ActivityRow,
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
export type {
  ActorId,
  ChangeId,
  ContractHead,
  ContractId,
  ContractState,
  ContractTarget,
  JournalEntry as Fact,
  FactKind,
  SnapshotId,
} from "./core/facts/types.js";
export {
  kanshi,
  kanshiCategory,
  kanshiCounts,
  kanshiCountsReportSchema,
  observeKanshi,
  selectRegion,
  regionReadSchema,
  kanshiReportSchema,
  kanshiCategoryReportSchema,
  kanshiContractReportSchema,
  kanshiResultSchema,
  kanshiObservationSchema,
} from "./kanshi/index.js";
export type { KanshiCountsInput, KanshiCountsReport } from "./kanshi/index.js";
export type {
  AkumaKanshiRow,
  AkumaKanshiWorld,
  ContractEndpointObservation,
  ContractHolderObservation,
  ContractKanshiBoard,
  ContractKanshiDetail,
  KanshiContractReport,
  KanshiResult,
  KanshiCategoryInput,
  KanshiCategoryReport,
  KanshiInput,
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
  CreatedDebtObservation,
  DispatchAssociation,
  ForkInput,
  ForkResult,
  SpawnInput,
  SpawnResult,
  SpawnWaitHead,
} from "./library/akumas.js";
export type { ContinuationReport } from "./library/continuation.js";
export { contractWaitMemberSchema, contractWaitResultSchema } from "./library/contract-wait.js";
export type {
  ContractWaitInput,
  ContractWaitOptions,
  ContractWaitMember,
  ContractWaitResult,
} from "./library/contract-wait.js";
export type { ReconcileInput } from "./library/contract-composition.js";
export {
  arcOutcomeSchema,
  abandonOutcomeSchema,
  bindOutcomeSchema,
  amendOutcomeSchema,
  deliveryPreviewOutcomeSchema,
  deliverOutcomeSchema,
  verifyOutcomeSchema,
  reviewOutcomeSchema,
} from "./library/contract-outcomes.js";
export type {
  AbandonOutcome,
  AmendOutcome,
  ArcOutcome,
  DeliveryPreviewInput,
  DeliveryPreviewOutcome,
  BindOutcome,
  BindResult,
  DeliverOutcome,
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
} from "./library/contract-types.js";
export { nukeKeiyaku as nuke, nukeResultSchema } from "./library/nuke.js";
export type { NukeInput, NukeResult } from "./library/nuke.js";
export type {
  InvocationIssue,
  Issue,
  ResetIssue,
  KeiyakuErrorCategory,
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
export { executionObservationSchema } from "./protocol/execution-observation.js";
export { contractStateSchema, journalEntrySchema } from "./protocol/result-leaves.js";
export type { ExecutionObservation, ExecutionObserver } from "./protocol/execution-observation.js";
export type { ExecutionStop } from "./protocol/progress.js";
export {
  contractSummarySchema,
  contractDetailSchema,
  contractCatalogueSchema,
  contractObservationSchema,
} from "./protocol/read/status.js";
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
export {
  SettingsError,
  settings,
  settingsSchema,
  settingsNamespaceViewSchema,
  settingsScopeStateSchema,
  settingsEntrySchema,
} from "./settings.js";
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
export type * from "./debt/index.js";
export {
  DEBT_RELATION_PREDICATE_FIELDS,
  DebtAuthorityCorruptionError,
  Debts,
  debtAbsentSchema,
  debtDetailSchema,
  debtSummarySchema,
  debtWarningSchema,
  debtReadPageSchema,
  debtReadResultSchema,
  debtShowResultSchema,
  debtCatalogueSchema,
  debtListSchema,
  debtReadyListSchema,
  readyDebtRowSchema,
  debtParentReadRefusalSchema,
  debtLifecycleResultSchema,
  debtTreeRootSchema,
  blockedDebtListSchema,
  debtQueryResultSchema,
  debtDoctorReportSchema,
  debtTreeResultSchema,
  debtMutationResultSchema,
  debtUpdateResultSchema,
  debtBatchResultSchema,
} from "./debt/index.js";
export {
  World,
  WorldError,
  worldRootSchema,
  worldResolutionSchema,
  worldLocationSchema,
  worldEstablishedSchema,
} from "./world.js";
export type { WorldResolution, WorldResolutionInput, WorldRoot } from "./world.js";

export { reconcileCompletionSchema, repoReconcileReportSchema, reconcileResultSchema } from "./library/reconcile.js";
export type { ReconcileReport, TopologyEffect } from "./library/reconcile.js";
