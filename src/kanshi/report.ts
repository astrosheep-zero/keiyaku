import type { ContractBoard, ContractDisposition, SnapshotId, TaskId } from "../library/contract.js";
import type { TaskRef, TaskStatusRow } from "../task/index.js";
import type { AkumaList, AkumaListRow, UnbornAkumaListRow } from "../akuma/index.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";

export type Section<Value> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

export type ContractEndpointObservation = ContractDisposition | "missing" | "unavailable";

export type ContractHolderObservation =
  | Readonly<{ kind: "held"; taskId: TaskId; disposition: "held" }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unavailable" }>;

export type ContractKanshiRow = ContractBoard["rows"][number] & Readonly<{
  holder: ContractHolderObservation;
}>;

export type ContractKanshiBoard = Omit<ContractBoard, "rows"> & Readonly<{
  rows: readonly ContractKanshiRow[];
}>;

export type TaskKanshiRow = TaskStatusRow & Readonly<{
  contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
  blockers?: readonly TaskRef[];
}>;

export type TaskKanshiWorld = Readonly<{
  root: WorldRoot;
  rows: readonly TaskKanshiRow[];
}>;

export type AkumaKanshiRow = (AkumaListRow | UnbornAkumaListRow) & Readonly<{
  aliases: readonly AkumaAlias[];
  contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
}>;

export type AkumaKanshiWorld = Omit<AkumaList, "rows"> & Readonly<{
  rows: readonly AkumaKanshiRow[];
}>;

export type KanshiReport = Readonly<{
  root: WorldRoot | null;
  observedAt: string;
  branch: string | null;
  state: SnapshotId | null;
  contracts: Section<ContractKanshiBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
}>;
