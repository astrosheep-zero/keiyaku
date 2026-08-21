import type { RegionRead, Section } from "../../kanshi/index.js";

function rows(section: Section<RegionRead>): readonly string[] {
  if (section.kind === "absent") return [];
  if (section.kind === "failed") return [`region failed ${section.failure.message}`];
  const value = section.value;
  if (value.kind === "declarations")
    return value.declarations.map((declaration) => `region ${declaration.contract} ${declaration.patterns.join(" ")}`);
  if (value.kind === "contract")
    return [`region ${value.declaration.contract} ${value.declaration.patterns.join(" ")}`];
  if (value.kind === "path")
    return value.matches.map((match) => `path ${value.path} ${match.contract} ${match.pattern}`);
  return value.intersections.flatMap((intersection) =>
    intersection.patterns.map(
      (pattern) => `overlap ${intersection.left} ${pattern.left} ~ ${intersection.right} ${pattern.right}`,
    ),
  );
}

export function renderRegionText(section: Section<RegionRead>): string {
  return rows(section).join("\n");
}
