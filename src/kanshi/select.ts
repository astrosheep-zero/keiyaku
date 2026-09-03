import { regionsOverlap } from "../body/region.js";
import type { KanshiReport } from "./report.js";
import type { KanshiRegionSelection, RegionDeclaration, RegionOverlap, RegionRead } from "./report.js";

export type KanshiSelection = Readonly<{ contract: string }>;

function regionOverlaps(
  mine: readonly string[],
  declarations: readonly RegionDeclaration[],
): readonly RegionOverlap[] {
  const overlaps: RegionOverlap[] = [];
  for (const declaration of declarations) {
    const pairs = regionsOverlap(mine, declaration.patterns);
    if (pairs.length === 0) continue;
    overlaps.push({
      contract: declaration.contract,
      patterns: pairs.map(([minePattern, theirsPattern]) => ({ mine: minePattern, theirs: theirsPattern })),
    });
  }
  return overlaps;
}

export function selectKanshi(
  input: Readonly<{
    report: KanshiReport;
    contract: string;
  }>,
): KanshiReport {
  const { report, contract } = input;
  return {
    ...report,
    contracts:
      report.contracts.kind === "present"
        ? {
            kind: "present",
            value: {
              ...report.contracts.value,
              rows: report.contracts.value.rows.filter((row) => row.id === contract),
            },
          }
        : report.contracts,
    tasks:
      report.tasks.kind === "present"
        ? {
            kind: "present",
            value: {
              ...report.tasks.value,
              rows: report.tasks.value.rows.filter((row) => row.contract?.id === contract),
            },
          }
        : report.tasks,
    akuma:
      report.akuma.kind === "present"
        ? {
            kind: "present",
            value: {
              ...report.akuma.value,
              rows: report.akuma.value.rows.filter((row) => row.contract?.id === contract),
            },
          }
        : report.akuma,
  };
}

export function selectRegion(
  input: Readonly<{
    declarations: readonly RegionDeclaration[];
    selection: KanshiRegionSelection;
  }>,
): RegionRead {
  const { declarations, selection } = input;
  if (selection.kind === "declarations") return { kind: "declarations", declarations };
  if (selection.kind === "contract") {
    const declaration = declarations.find((value) => value.contract === selection.contract);
    if (declaration === undefined) throw new Error(`active contract not found: ${selection.contract}`);
    return {
      kind: "contract",
      declaration,
      overlaps: regionOverlaps(
        declaration.patterns,
        declarations.filter((value) => value.contract !== selection.contract),
      ),
    };
  }
  return {
    kind: "path",
    patterns: selection.patterns,
    overlaps: regionOverlaps(selection.patterns, declarations),
  };
}
