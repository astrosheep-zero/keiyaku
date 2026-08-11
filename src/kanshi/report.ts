import type { ContractBoard, ContractDisposition } from "../library/contract.js";
import type { TaskRow } from "../task/index.js";
import type { AkumaList, AkumaListRow, UnbornAkumaListRow } from "../akuma/index.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";

export type Section<Value> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

export type ContractEndpointObservation = ContractDisposition | "missing" | "unavailable";

export type TaskKanshiRow = TaskRow & Readonly<{
  contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
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
  contracts: Section<ContractBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
}>;
