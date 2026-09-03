import type { ContractBoard, ContractDisposition, ContractPhase } from "../library/contract.js";
import type { TaskId, TaskRef, TaskRow } from "../task/index.js";
import type { AkumaList, AkumaListRow, UnbornAkumaListRow, ActivitySnapshot } from "../akuma/akuma.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { WorldRoot } from "../world.js";
import type { ContractId } from "../library/contract.js";
import type { RegionOverlap } from "../library/region.js";
import type { CurrentPhysicalIssue } from "../protocol/read/observation.js";
import type { BoundedList } from "../bounded-list.js";

export type { RegionOverlap };

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

export type ContractKanshiRow = ContractBoard["rows"][number] &
  Readonly<{
    phase: ContractPhase;
    holder: ContractHolderObservation;
    fleet: readonly ContractFleetAttachment[];
    namespaceTasks?: Section<readonly TaskRow[]>;
    issue?: CurrentPhysicalIssue;
  }>;

export type ContractKanshiBoard = Omit<ContractBoard, "rows"> &
  Readonly<{
    rows: readonly ContractKanshiRow[];
    hasMore?: boolean;
  }>;

export type TaskKanshiRow = TaskRow &
  Readonly<{
    contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
    blockers?: readonly TaskRef[];
  }>;

export type TaskKanshiWorld = BoundedList<TaskKanshiRow> & Readonly<{ root: WorldRoot }>;

export type AkumaKanshiRow = (AkumaListRow | UnbornAkumaListRow) &
  Readonly<{
    aliases: readonly AkumaAlias[];
    contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
    snapshot?: ActivitySnapshot;
  }>;

export type AkumaKanshiWorld = Omit<AkumaList, "rows"> &
  Readonly<{
    rows: readonly AkumaKanshiRow[];
  }>;

export type KanshiRegionSelection =
  | Readonly<{ kind: "declarations" }>
  | Readonly<{ kind: "contract"; contract: ContractId }>
  | Readonly<{ kind: "path"; patterns: readonly [string, ...string[]] }>;

export type RegionDeclaration = Readonly<{ contract: ContractId; patterns: readonly string[] }>;
export type RegionRead =
  | Readonly<{ kind: "declarations"; declarations: readonly RegionDeclaration[] }>
  | Readonly<{
      kind: "contract";
      declaration: RegionDeclaration;
      overlaps: readonly RegionOverlap[];
    }>
  | Readonly<{
      kind: "path";
      patterns: readonly string[];
      overlaps: readonly RegionOverlap[];
    }>;

export type KanshiReport = Readonly<{
  root: WorldRoot | null;
  observedAt: string;
  branch: string | null;
  contracts: Section<ContractKanshiBoard>;
  tasks: Section<TaskKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
  region?: Section<RegionRead>;
}>;
export type { CurrentPhysicalIssue };
