import type { KanshiReport } from "./report.js";
import { regionIntersections, regionPathMatches } from "../library/region.js";
import type { KanshiRegionSelection, RegionDeclaration, RegionIntersection, RegionRead } from "./report.js";

export type KanshiSelection = Readonly<{ contract: string }>;

export function selectKanshi(input: Readonly<{
  report: KanshiReport;
  contract: string;
}>): KanshiReport {
  const { report, contract } = input;
  return {
    ...report,
    contracts: report.contracts.kind === "present"
      ? { kind: "present", value: { ...report.contracts.value, rows: report.contracts.value.rows.filter((row) => row.id === contract) } }
      : report.contracts,
    tasks: report.tasks.kind === "present"
      ? { kind: "present", value: { ...report.tasks.value, rows: report.tasks.value.rows.filter((row) => row.contract?.id === contract) } }
      : report.tasks,
    akuma: report.akuma.kind === "present"
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

export function selectRegion(input: Readonly<{
  declarations: readonly RegionDeclaration[];
  selection: KanshiRegionSelection;
}>): RegionRead {
  const { declarations, selection } = input;
  if (selection.kind === "declarations") return { kind: "declarations", declarations };
  if (selection.kind === "contract") {
    const declaration = declarations.find((value) => value.contract === selection.contract);
    if (declaration === undefined) throw new Error(`active contract not found: ${selection.contract}`);
    return { kind: "contract", declaration };
  }
  if (selection.kind === "path") {
    const matches = declarations.flatMap((declaration) => regionPathMatches(declaration.patterns, selection.path).map((pattern) => ({ contract: declaration.contract, pattern })));
    return { kind: "path", path: selection.path, matches };
  }
  const intersections: RegionIntersection[] = [];
  for (let leftIndex = 0; leftIndex < declarations.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < declarations.length; rightIndex += 1) {
      const left = declarations[leftIndex]!;
      const right = declarations[rightIndex]!;
      if (selection.contract !== undefined && left.contract !== selection.contract && right.contract !== selection.contract) continue;
      const patterns = regionIntersections(left.patterns, right.patterns);
      if (patterns.length > 0) intersections.push({ left: left.contract, right: right.contract, patterns });
    }
  }
  if (selection.contract !== undefined && !declarations.some((value) => value.contract === selection.contract)) {
    throw new Error(`active contract not found: ${selection.contract}`);
  }
  return { kind: "overlap", ...(selection.contract === undefined ? {} : { subject: selection.contract }), intersections };
}
