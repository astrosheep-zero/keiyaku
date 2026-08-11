import {
  KeiyakuHandle,
  bindKeiyaku,
  keiyakuOf,
  listKeiyaku,
  observeKeiyaku,
  type Keiyaku as KeiyakuType,
} from "./contract.js";

export { AuthorityCorruptionError } from "../core/facts/errors.js";
export {
  Delivery,
  KeiyakuRefused,
  KeiyakuRetry,
} from "./contract.js";
export { NoGitWorldError, Repo } from "./repo.js";
export {
  gatesFrom,
  SettingsError,
  worktreeHooksFrom,
} from "./configuration.js";

export type {
  AbandonInput,
  ActorId,
  AmendInput,
  AmendResult,
  ArcInput,
  AttestationVerdict,
  AuditInput,
  AuditReport,
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
  WorktreeHooks,
  WorktreeHooksFromInput,
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

export type Keiyaku = KeiyakuType;

export const Keiyaku = Object.freeze({
  prototype: KeiyakuHandle.prototype,
  [Symbol.hasInstance]: (value: unknown): boolean => value instanceof KeiyakuHandle,
  bind: bindKeiyaku,
  list: listKeiyaku,
  observe: observeKeiyaku,
  of: keiyakuOf,
});
