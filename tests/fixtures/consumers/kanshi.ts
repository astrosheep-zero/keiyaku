import {
  kanshi,
  kanshiCategory,
  selectKanshi,
  type ContractId,
  type KanshiCategoryInput,
  type KanshiCategoryReport,
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
const categoryInput: KanshiCategoryInput = { world: null, category: "akuma" };
declare const categoryReport: KanshiCategoryReport;
// @ts-expect-error an unknown category is not admitted at the public edge
const unknownCategory: KanshiCategoryInput = { world: null, category: "people" };
// @ts-expect-error the category report is a tagged union, not a loose record
const untypedCategoryReport: KanshiCategoryReport = { category: "people", root: null, observedAt: "" };
void kanshi;
void kanshiCategory;
void selectKanshi;
void categoryInput;
void categoryReport;
void unknownCategory;
void untypedCategoryReport;
void declarations;
void contract;
void path;
void declaration;
void overlap;
void read;
void input;
void deletedSelection;
