import { emptyCatalogue } from "./terminal.js";
import type { RegionOverlap, RegionRead } from "../../kanshi/index.js";

function overlapBlocks(overlaps: readonly RegionOverlap[]): readonly string[] {
  return overlaps.flatMap((overlap) => {
    const patterns = overlap.patterns.filter((pattern) => pattern.mine !== pattern.theirs);
    if (patterns.length === 0) return [`overlap  ${overlap.contractId}  exact match`];
    const count = patterns.length;
    return [
      `overlap  ${overlap.contractId}  ${count} ${count === 1 ? "pair" : "pairs"}`,
      ...patterns.map((pattern) => `  ${pattern.mine} ~ ${pattern.theirs}`),
    ];
  });
}

/** The edge refusals are rendered by the CLI refusal grammar; this owns the owner observation. */
export type RegionObservation = Exclude<RegionRead, { kind: "contract-missing" } | { kind: "contract-terminal" }>;

export function renderRegionText(
  result: RegionObservation,
  input: Readonly<{ contract?: string; paths?: readonly string[] }> = {},
): string {
  if (result.kind === "absent") return emptyCatalogue("region");
  if (result.kind === "failed") return [`× region`, `  reason  ${result.diagnostic}`].join("\n");
  if ("id" in result) {
    const header = `region  ${result.id}  ${result.patterns.join(" ")}`;
    return [header, ...(result.overlaps === undefined ? ["  overlap  none"] : overlapBlocks(result.overlaps))].join(
      "\n",
    );
  }
  if (input.paths !== undefined) {
    const overlaps = "overlaps" in result ? result.overlaps : undefined;
    return (overlaps === undefined ? ["region  none"] : overlapBlocks(overlaps)).join("\n");
  }
  const declarations = "declarations" in result ? (result.declarations ?? []) : [];
  return declarations.length === 0
    ? emptyCatalogue("region")
    : declarations.map((declaration) => `region  ${declaration.id}  ${declaration.patterns.join(" ")}`).join("\n");
}
