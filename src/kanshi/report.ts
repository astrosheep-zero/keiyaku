import type { AkumaList, AkumaListRow, UnbornAkumaListRow } from "../akuma/akuma.js";
import type { ActivitySnapshot } from "../akuma/projection.js";
import type { BoundedList } from "../bounded-list.js";
import type { AkumaAlias } from "../identity/selector.js";
import type { ContractId } from "../index.js";
import type { RegionOverlap } from "../library/region.js";
import type { CurrentPhysicalIssue } from "../protocol/read/observation.js";
import type { ContractBoard, ContractDisposition, ContractPhase } from "../protocol/read/status.js";
import type { DebtId, DebtRef, DebtRow } from "../debt/index.js";
import type { WorldRoot } from "../world.js";

export type { RegionOverlap };

export type Section<Value> =
  | Readonly<{ kind: "present"; value: Value }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed"; failure: Readonly<{ message: string; coordinate?: string }> }>;

export type ContractEndpointObservation = ContractDisposition | "missing" | "unavailable";

export type ContractHolderObservation =
  | Readonly<{ kind: "held"; debtId: DebtId }>
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "unavailable" }>;

export type ContractRosterAttachment = Readonly<{
  id: string;
  aliases: readonly AkumaAlias[];
  aliasesUnavailable?: true;
}>;

export type ContractKanshiRow = ContractBoard["rows"][number] &
  Readonly<{
    phase: ContractPhase;
    holder: ContractHolderObservation;
    roster: readonly ContractRosterAttachment[];
    rosterUnavailable?: true;
    namespaceDebts?: Section<readonly DebtRow[]>;
    issue?: CurrentPhysicalIssue;
  }>;

export type ContractKanshiBoard = Omit<ContractBoard, "rows"> &
  Readonly<{
    rows: readonly ContractKanshiRow[];
    hasMore?: boolean;
  }>;

export type DebtKanshiRow = DebtRow &
  Readonly<{
    contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
    contractAssociationUnavailable?: true;
    blockers?: readonly DebtRef[];
  }>;

export type DebtKanshiWorld = BoundedList<DebtKanshiRow> & Readonly<{ root: WorldRoot }>;

export type AkumaKanshiRow = (AkumaListRow | UnbornAkumaListRow) &
  Readonly<{
    aliases: readonly AkumaAlias[];
    contract?: Readonly<{ id: string; observed: ContractEndpointObservation }>;
    contractAssociationUnavailable?: true;
    snapshot?: ActivitySnapshot;
  }>;

export type AkumaKanshiWorld = Omit<AkumaList, "rows"> &
  Readonly<{
    rows: readonly AkumaKanshiRow[];
    aliasesUnavailable?: true;
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
  debts: Section<DebtKanshiWorld>;
  akuma: Section<AkumaKanshiWorld>;
  region?: Section<RegionRead>;
}>;

/** Internal category observation retains only the requested owner section. */
export type KanshiCategoryReport =
  | Readonly<{
      category: "akuma";
      root: WorldRoot | null;
      observedAt: string;
      akuma: Section<AkumaKanshiWorld>;
    }>
  | Readonly<{
      category: "contract";
      root: WorldRoot | null;
      observedAt: string;
      contracts: Section<ContractKanshiBoard>;
    }>;
export type { CurrentPhysicalIssue };
