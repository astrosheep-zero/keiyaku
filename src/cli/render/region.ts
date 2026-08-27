import type { RegionOverlap, RegionRead, Section } from "../../kanshi/index.js";

function overlapBlocks(overlaps: readonly RegionOverlap[]): readonly string[] {
  return overlaps.flatMap((overlap) => {
    const patterns = overlap.patterns.filter((pattern) => pattern.mine !== pattern.theirs);
    if (patterns.length === 0) return [`overlap ${overlap.contract} exact match`];
    const count = patterns.length;
    return [
      `overlap ${overlap.contract} ${count} ${count === 1 ? "pair" : "pairs"}`,
      ...patterns.map((pattern) => `  ${pattern.mine} ~ ${pattern.theirs}`),
    ];
  });
}

function rows(section: Section<RegionRead>): readonly string[] {
  if (section.kind === "absent") return [];
  if (section.kind === "failed") return [`region failed ${section.failure.message}`];
  const value = section.value;
  if (value.kind === "declarations") {
    if (value.declarations.length === 0) return ["no active Region declarations"];
    return value.declarations.map((declaration) => `region ${declaration.contract} ${declaration.patterns.join(" ")}`);
  }
  if (value.kind === "contract") {
    const header = `region ${value.declaration.contract} ${value.declaration.patterns.join(" ")}`;
    if (value.overlaps.length === 0) return [header, "no overlap with active declarations"];
    return [header, ...overlapBlocks(value.overlaps)];
  }
  if (value.overlaps.length === 0) return [`no active Region declares: ${value.patterns.join(" ")}`];
  return [...overlapBlocks(value.overlaps)];
}

export function renderRegionText(section: Section<RegionRead>): string {
  return rows(section).join("\n");
}
