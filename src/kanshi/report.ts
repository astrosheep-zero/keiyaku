import type { ContractBoard, ContractDisposition } from "../library/contract.js";
import type { TaskId, TaskRef, TaskRow } from "../task/index.js";
import type { AkumaList, AkumaListRow, UnbornAkumaListRow } from "../akuma/index.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";
import type { ContractId } from "../library/contract.js";

export type Section<Value> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string }> }>;

export type ContractEndpointObservation = ContractDisposition | "missing" | "unavailable";

export type ContractHolderObservation =
  | Readonly<{ kind: "held"; taskId: TaskId }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unavailable" }>;

export type ContractFleetAttachment = Readonly<{
  id: string;
  aliases: readonly AkumaAlias[];
}>;

export type ContractKanshiRow = ContractBoard["rows"][number] & Readonly<{
  holder: ContractHolderObservation;
  fleet: readonly ContractFleetAttachment[];
  namespaceTasks: Section<readonly TaskRow[]>;
}>;

export type ContractKanshiBoard = Omit<ContractBoard, "rows"> & Readonly<{
  rows: readonly ContractKanshiRow[];
}>;

export type TaskKanshiRow = TaskRow & Readonly<{
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

export type KanshiRegionSelection =
  | Readonly<{ kind: "declarations" }>
  | Readonly<{ kind: "contract"; contract: ContractId }>
  | Readonly<{ kind: "overlap"; contract?: ContractId }>
  | Readonly<{ kind: "path"; path: string }>;

export type RegionDeclaration = Readonly<{ contract: ContractId; patterns: readonly string[] }>;
export type RegionIntersection = Readonly<{
  left: ContractId;
  right: ContractId;
  patterns: readonly Readonly<{ left: string; right: string }>[];
}>;
export type RegionPathMatch = Readonly<{ contract: ContractId; pattern: string }>;
export type RegionRead =
  | Readonly<{ kind: "declarations"; declarations: readonly RegionDeclaration[] }>
  | Readonly<{ kind: "contract"; declaration: RegionDeclaration }>
  | Readonly<{ kind: "overlap"; subject?: ContractId; intersections: readonly RegionIntersection[] }>
  | Readonly<{ kind: "path"; path: string; matches: readonly RegionPathMatch[] }>;

export type KanshiReport = Readonly<{
  root: WorldRoot | null;
  observedAt: string;
  branch: string | null;
  contracts: Section<ContractKanshiBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
  region?: Section<RegionRead>;
}>;
