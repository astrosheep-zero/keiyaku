import type { ContractId, RegionOverlap as RootOverlap } from "@astrosheep/keiyaku";
import {
  kanshi,
  type KanshiInput,
  type KanshiRegionSelection,
  type RegionDeclaration,
  type RegionOverlap,
  type RegionRead,
} from "@astrosheep/keiyaku/kanshi";
const id = "kei/example" as ContractId;
const declarations: KanshiRegionSelection = { kind: "declarations" };
const contract: KanshiRegionSelection = { kind: "contract", contract: id };
const path: KanshiRegionSelection = { kind: "path", patterns: ["src/**", "tests/**"] as [string, ...string[]] };
const declaration: RegionDeclaration = { contract: id, patterns: ["src/**"] };
const overlap: RegionOverlap = { contract: id, patterns: [{ mine: "src/**", theirs: "src/cli/**" }] };
const rootOverlap: RootOverlap = overlap;
const read: RegionRead = { kind: "contract", declaration, overlaps: [rootOverlap] };
const input: KanshiInput = { world: null, region: path };
// @ts-expect-error overlap selection was deleted
const deletedSelection: KanshiRegionSelection = { kind: "overlap" };
// @ts-expect-error RegionIntersection is not exported
type DeletedIntersection = import("@astrosheep/keiyaku/kanshi").RegionIntersection;
// @ts-expect-error RegionPathMatch is not exported
type DeletedPathMatch = import("@astrosheep/keiyaku/kanshi").RegionPathMatch;
void kanshi;
void declarations;
void contract;
void path;
void declaration;
void overlap;
void rootOverlap;
void read;
void input;
void deletedSelection;
