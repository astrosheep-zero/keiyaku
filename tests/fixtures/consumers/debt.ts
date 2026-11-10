import {
  Debts,
  Keiyaku,
  World,
  type AddDebtInput,
  type Debt,
  type DebtAbsent,
  type DebtBatchResult,
  type DebtCatalogue,
  type DebtDetail,
  type DebtId,
  type DebtLsInvocation,
  type DebtMutationResult,
  type DebtLifecycleResult,
  type DebtReadResult,
  type DebtShowItem,
  type DebtShowResult,
  type DebtTreeResult,
  type DebtTreeNode,
  type DebtUpdateResult,
} from "@astrosheep/keiyaku";
const world = null as unknown as import("@astrosheep/keiyaku").WorldRoot;
const facet = Keiyaku.at({ cwd: "/tmp", environment: {} });
const listing: DebtLsInvocation = { of: "debt", namespace: [], selection: "all" };
const catalogue: Promise<DebtCatalogue> = facet.ls(listing);
const one: Promise<DebtShowResult | DebtAbsent> = facet.debtShow({ id: "debt/example" });
const many: Promise<DebtShowResult | DebtAbsent> = facet.debtShow({ ids: ["debt/example"] });
const batch: Promise<DebtBatchResult> = facet.debtDone({ ids: ["debt/example"] });
const created: Promise<DebtMutationResult> = facet.debtAdd({ title: "Example" });
void facet.debtAddDocument({ markdown: "# Example" });
void facet.debtUpdate({ id: "debt/example", note: "updated" });
void facet.debtDrop({ ids: ["debt/example"] });
void facet.debtQuery();
void facet.debtDoctor();
const selectedTree: Promise<DebtTreeResult | DebtAbsent> = facet.debtTree({ id: "debt/example" });
const debts = Debts.of(world);
const debt: Debt = debts.debt({ id: "debt/example" });
const id: DebtId = debt.id;
const result: Promise<DebtMutationResult> = debts.add({ title: "Example", state: "open", note: "initial" });
const read: Promise<DebtReadResult> = debt.read();
const tree: Promise<DebtTreeResult> = debt.tree();
const update: Promise<DebtUpdateResult> = debt.update({ note: "replacement" });
const node = null as unknown as DebtTreeNode;
void debt.drop({ note: "obsolete" });

function firstFound(items: readonly DebtShowItem[]): DebtDetail | undefined {
  const first = items[0];
  return first?.kind === "found" ? first : undefined;
}
function foundTitles(shown: DebtShowResult | DebtAbsent): readonly string[] {
  return shown.kind === "absent" ? [] : shown.items.flatMap((item) => item.kind === "found" ? [item.title] : []);
}
function acceptedId(mutation: DebtMutationResult): DebtId | undefined {
  return mutation.kind === "accepted" ? mutation.id : undefined;
}
function batchKinds(completed: DebtBatchResult) {
  return completed.items.map((item) => item.kind);
}
function treeRoot(decomposition: DebtTreeResult) {
  return decomposition.kind === "present" ? decomposition : undefined;
}
const closedDebt: Promise<DebtLifecycleResult> = debt.done();
const defaultAdd: AddDebtInput = { title: "Example" };
void [catalogue, one, many, batch, created, selectedTree, read, update];
void [firstFound, foundTitles, acceptedId, batchKinds, treeRoot, defaultAdd, closedDebt];

// @ts-expect-error Debt has no static construction surface
Debt.at({ path: "." });
// @ts-expect-error callers do not choose IDs during creation
debts.add({ id: "debt/chosen", title: "Chosen" });
// @ts-expect-error tree accepts no full option
void debt.tree({ full: true });
// @ts-expect-error the removed execution carrier is not a public input
Debts.of(world, { execution: {} });
function batchOutcome(completed: DebtBatchResult) {
  // @ts-expect-error batch items are flat; there is no nested outcome
  return completed.items[0].outcome;
}
// @ts-expect-error show is one native result, not a bare detail or null
const bareShow: Promise<DebtDetail | null> = facet.debtShow({ id: "debt/example" });
// @ts-expect-error DAG residue type is not exported
type OldTree = import("@astrosheep/keiyaku").DebtDependencyTree;
// @ts-expect-error the retired ./debt subpath promise is gone
type RemovedDebtSubpath = import("@astrosheep/keiyaku/debt").DebtRow;
void World;
void debts;
void debt;
void id;
void result;
void tree;
void node;
void batchOutcome;
void bareShow;
