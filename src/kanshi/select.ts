import { regionsOverlapWithRelation } from "../body/region.js";
import type { KanshiRegionSelection, RegionDeclaration, RegionOverlap, RegionRead } from "./report.js";

function regionOverlaps(mine: readonly string[], declarations: readonly RegionDeclaration[]): readonly RegionOverlap[] {
  return declarations.flatMap((declaration) => {
    const pairs = regionsOverlapWithRelation(mine, declaration.patterns);
    return pairs.length === 0
      ? []
      : [
          {
            contractId: declaration.id,
            patterns: pairs.map(([minePattern, theirsPattern, relation]) => ({
              mine: minePattern,
              theirs: theirsPattern,
              ...(relation === "same" ? {} : { relation }),
            })),
          },
        ];
  });
}

export function selectRegion(
  input: Readonly<{ declarations: readonly RegionDeclaration[]; selection: KanshiRegionSelection }>,
): RegionRead {
  const { declarations, selection } = input;
  if (selection.kind === "declarations")
    return { kind: "present", ...(declarations.length === 0 ? {} : { declarations }) };
  if (selection.kind === "contract") {
    const declaration = declarations.find((value) => value.id === selection.contract);
    if (declaration === undefined) return { kind: "contract-missing", id: selection.contract };
    const overlaps = regionOverlaps(
      declaration.patterns,
      declarations.filter((value) => value.id !== selection.contract),
    );
    return { kind: "present", ...declaration, ...(overlaps.length === 0 ? {} : { overlaps }) };
  }
  const overlaps = regionOverlaps(selection.patterns, declarations);
  return { kind: "present", ...(overlaps.length === 0 ? {} : { overlaps }) };
}
