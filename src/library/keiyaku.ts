import {
  KeiyakuHandle,
  bindKeiyaku,
  keiyakuOf,
  listKeiyaku,
  observeKeiyaku,
  type Keiyaku as KeiyakuType,
} from "./contract.js";
import { callKeiyaku, forkKeiyaku } from "./akuma-creation.js";
import {
  historyAkuma,
  interruptAkuma,
  killAkuma,
  statusAkuma,
  tellAkuma,
  waitAkuma,
} from "./fleet.js";
import { listCatalog } from "./catalog.js";

export { AuthorityCorruptionError } from "../core/facts/errors.js";
export {
  Delivery,
  KeiyakuRefused,
  KeiyakuRetry,
} from "./contract.js";
export { NoGitWorldError, Repo } from "./repo.js";
export {
  gatesFrom,
  requireBranchesToBeUpToDateFrom,
  SettingsError,
} from "./configuration.js";
export { worktreeHooksFrom } from "../git/hooks.js";

export type {
  AbandonInput,
  ActorId,
  AmendInput,
  AmendResult,
  ArcInput,
  AttestationVerdict,
  AuditInput,
  AuditPreview,
  AuditReport,
  DeliveryPreparationRefusal,
  BindInput,
  BindResult,
  ContractBoard,
  ContractDisposition,
  ContractGateCurrent,
  ContractGateReport,
  ContractListInput,
  ContractObservation,
  ContractObservationInput,
  ContractPhase,
  ContractRow,
  DeliverInput,
  Fact,
  FactKind,
  KeiyakuOfInput,
  KeiyakuRefusal,
  KeiyakuRetryReason,
  Lag,
  MutationResult,
  PlacementStop,
  ReconcileReport,
  Review,
  ReviewInput,
  TimelineEntry,
  TaskId,
  TopologyEffect,
  VerificationReuse,
  VerificationStop,
} from "./contract.js";
export type {
  ContractId,
  ContractState,
  ChangeId,
  SnapshotId,
} from "../core/facts/types.js";
export type {
  Gate,
  GatesFromInput,
  HookCommand,
  RequireBranchesToBeUpToDateFromInput,
  WorktreeHooks,
} from "./configuration.js";
export type { RegionOverlap } from "./region.js";
export type {
  ReconcileInput,
  RepoAtInput,
  RepoReconcileReport,
} from "./repo.js";
export type {
  SettlementAction,
  SettlementLag,
  SettlementReport,
} from "../settlement/settle.js";
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
export type { Catalog, CatalogInput, CatalogQuery } from "./catalog.js";
export type {
  AkumaAddressInput,
  AkumaSetAddressInput,
  DirectAkumaSelector,
  SetAkumaSelector,
} from "./address.js";
export type {
  AkumaHistoryInput,
  AkumaHistoryResult,
  AkumaInterruptInput,
  AkumaInterruptResult,
  AkumaKillResult,
  AkumaStatusView,
  AkumaTellInput,
  AkumaTellResult,
  AkumaWaitInput,
  AkumaWaitResult,
} from "./fleet.js";

export type Keiyaku = KeiyakuType;

export const Keiyaku = Object.freeze({
  prototype: KeiyakuHandle.prototype,
  [Symbol.hasInstance]: (value: unknown): boolean => value instanceof KeiyakuHandle,
  bind: bindKeiyaku,
  call: callKeiyaku,
  fork: forkKeiyaku,
  history: historyAkuma,
  interrupt: interruptAkuma,
  kill: killAkuma,
  ls: listCatalog,
  list: listKeiyaku,
  observe: observeKeiyaku,
  of: keiyakuOf,
  status: statusAkuma,
  tell: tellAkuma,
  wait: waitAkuma,
});
