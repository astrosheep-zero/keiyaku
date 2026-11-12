import { contractId, type ContractId } from "../core/facts/types.js";
import { kanshiCounts, type KanshiCountsReport } from "./counts.js";
import {
  captureKanshiScope,
  observeKanshi,
  readKanshiRegion,
  type KanshiBoardOptions,
  type KanshiScopeInput,
} from "./read.js";
import type { KanshiContractReport, KanshiRegionSelection, KanshiReport, RegionRead } from "./report.js";

export type Kanshi = KanshiHandle;

class KanshiHandle {
  readonly #scope: ReturnType<typeof captureKanshiScope>;

  constructor(scope: KanshiScopeInput) {
    this.#scope = captureKanshiScope(scope);
    Object.freeze(this);
  }

  async board(options: KanshiBoardOptions = {}): Promise<KanshiReport> {
    return (await observeKanshi(this.#scope, options)).report;
  }

  counts(): Promise<KanshiCountsReport> {
    return kanshiCounts(this.#scope);
  }

  region(selection: KanshiRegionSelection | Readonly<Record<string, never>> = {}): Promise<RegionRead> {
    return readKanshiRegion(this.#scope.repo, selection);
  }

  async contract(id: ContractId): Promise<KanshiContractReport> {
    return (await observeKanshi({ ...this.#scope, contract: contractId(id) })).report;
  }
}

export const Kanshi = Object.freeze({
  of(scope: KanshiScopeInput): Kanshi {
    return new KanshiHandle(scope);
  },
});

export { kanshiObservationSchema } from "./read.js";
export { kanshiCountsReportSchema } from "./counts.js";
export type { KanshiCountsReport } from "./counts.js";
export { regionReadSchema, kanshiReportSchema, kanshiContractReportSchema, kanshiResultSchema } from "./report.js";
export type { KanshiBoardOptions, KanshiScopeInput } from "./read.js";
export type {
  AkumaKanshiRow,
  AkumaKanshiWorld,
  ContractEndpointObservation,
  ContractHolderObservation,
  ContractKanshiBoard,
  ContractKanshiDetail,
  KanshiContractReport,
  KanshiResult,
  KanshiReport,
  Section,
  DebtKanshiRow,
  DebtKanshiWorld,
  KanshiRegionSelection,
  RegionDeclaration,
  RegionOverlap,
  RegionRead,
} from "./report.js";
