import {
  Kanshi,
  type ContractAssociation,
  type ContractGate,
  type ContractId,
  type KanshiContractReport,
  type ObservationSection,
  type KanshiScopeInput,
  type KanshiRegionSelection,
  type RegionDeclaration,
  type RegionOverlap,
  type RegionRead,
} from "@astrosheep/keiyaku";
const id = "kei/example" as ContractId;
const declarations: KanshiRegionSelection = { kind: "declarations" };
const contract: KanshiRegionSelection = { kind: "contract", contract: id };
const path: KanshiRegionSelection = { kind: "path", patterns: ["src/**", "tests/**"] as [string, ...string[]] };
const declaration: RegionDeclaration = { id, patterns: ["src/**"] };
const overlap: RegionOverlap = {
  contractId: id,
  patterns: [{ mine: "src/**", theirs: "src/cli/**", relation: "theirs-within-mine" }],
};
const read: RegionRead = { kind: "present", ...declaration, overlaps: [overlap] };
const input: KanshiScopeInput = { world: null };
const view: Kanshi = Kanshi.of(input);
const regions: Promise<RegionRead> = view.region(path);
const selected: Promise<KanshiContractReport> = Kanshi.of({ world: null }).contract(id);
const exact = await selected;
if (exact.kind === "contract") {
  const links: readonly ContractAssociation[] = exact.associations ?? [];
  const gates: readonly ContractGate[] = exact.gates ?? [];
  const lag: number | undefined = exact.targetLag;
  void [links.flatMap((edge) => "akumaId" in edge ? [edge.akumaId] : []), gates, lag];
}
const count: ObservationSection<number> = (await view.counts()).contracts;
if (typeof count === "number") count.toFixed();
// @ts-expect-error overlap selection was deleted
const deletedSelection: KanshiRegionSelection = { kind: "overlap" };
// @ts-expect-error RegionIntersection is not exported
type DeletedIntersection = import("@astrosheep/keiyaku").RegionIntersection;
// @ts-expect-error the retired ./kanshi subpath promise is gone
type RemovedKanshiSubpath = import("@astrosheep/keiyaku/kanshi").KanshiReport;
void regions;
void selected;
void declarations;
void contract;
void path;
void declaration;
void overlap;
void read;
void input;
void deletedSelection;
