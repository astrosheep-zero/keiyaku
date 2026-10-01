import {
  kanshi,
  selectKanshi,
  type ContractId,
  type KanshiInput,
  type KanshiRegionSelection,
  type RegionDeclaration,
  type RegionOverlap,
  type RegionRead,
} from "@astrosheep/keiyaku";
const id = "kei/example" as ContractId;
const declarations: KanshiRegionSelection = { kind: "declarations" };
const contract: KanshiRegionSelection = { kind: "contract", contract: id };
const path: KanshiRegionSelection = { kind: "path", patterns: ["src/**", "tests/**"] as [string, ...string[]] };
const declaration: RegionDeclaration = { contract: id, patterns: ["src/**"] };
const overlap: RegionOverlap = {
  contract: id,
  patterns: [{ mine: "src/**", theirs: "src/cli/**", relation: "theirs-within-mine" }],
};
const read: RegionRead = { kind: "contract", declaration, overlaps: [overlap] };
const input: KanshiInput = { world: null, region: path };
// @ts-expect-error overlap selection was deleted
const deletedSelection: KanshiRegionSelection = { kind: "overlap" };
// @ts-expect-error RegionIntersection is not exported
type DeletedIntersection = import("@astrosheep/keiyaku").RegionIntersection;
// @ts-expect-error the retired ./kanshi subpath promise is gone
type RemovedKanshiSubpath = import("@astrosheep/keiyaku/kanshi").KanshiReport;
void kanshi;
void selectKanshi;
void declarations;
void contract;
void path;
void declaration;
void overlap;
void read;
void input;
void deletedSelection;
