import { readSoul } from "./heart/index.js";
import { pathsForAkuId, type AkuId } from "./identity.js";
import type { WorldRoot } from "../world.js";

export { Akuma, AkumaHandle, AkumaNotBornError } from "./akuma.js";
export type { AkumaCallInput } from "./akuma.js";
export { ALLOWED_ACTIONS } from "./allowed.js";
export type { AllowedAction, AllowedActions } from "./allowed.js";
export type { WorldRoot } from "../world.js";

export async function probeBornAkuma(worldPath: WorldRoot, id: AkuId): Promise<boolean> {
  const soul = await readSoul(pathsForAkuId(worldPath, id));
  return soul !== null;
}

export { AkumaArchetypeError, listArchetypeDefinitions, listArchetypes } from "./archetype.js";
export type { ArchetypeCatalogRow } from "./archetype.js";
export { AkumaBodyRequestError } from "./requests.js";
export type {
  AkumaList,
  AkumaListInput,
  AkumaListRow,
  AkumaStatus,
  ActivityHistory,
  ActivityRow,
  ActivitySnapshot,
  ActivitySnapshotEntry,
  ForkReceipt,
  InterruptReceipt,
  TellResult,
  UnbornAkumaListRow,
} from "./akuma.js";
export type {
  ActiveToolRow,
  ClosedTurn,
  ClosedTurnRow,
  CompletedToolRow,
  HistoryCursor,
  HistoryPage,
  IdleSnapshotRow,
  OpenSnapshotRow,
  OpenTurn,
  OpenTurnRow,
  OutcomeRow,
  ReportedFileChange,
  RetainedWindow,
  Snapshot,
  SnapshotRow,
  TellRow,
  TurnLedger,
  TurnOutcome,
  TurnStartRow,
  UnsettledToolRow,
} from "./akuma.js";
export type { AgentEvent, ToolCall, ToolEvent, ToolResult } from "./provider.js";
export type { AkuId } from "./identity.js";
export type {
  Confinement,
  KillEvidence,
  ResumeCoordinate,
  TurnFact,
} from "./heart/index.js";
export type { ProviderOptions, ReadonlyRestraint } from "./provider-recipe.js";
