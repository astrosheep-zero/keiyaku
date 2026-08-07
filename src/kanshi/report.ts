import type { ContractBoard, ContractDisposition } from "../index.js";
import type { TaskRow } from "../task/index.js";

export type Section<Value> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

export type ContractEndpointObservation = ContractDisposition | "missing" | "unavailable";

export type TaskKanshiRow = Omit<TaskRow, "contractId"> & Readonly<{
  contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
}>;

export type TaskKanshiWorld = Readonly<{
  root: string;
  rows: readonly TaskKanshiRow[];
}>;

export type KanshiReport = Readonly<{
  root: string;
  contracts: Section<ContractBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<never>;
}>;
