import {
  Debts,
  World,
  type Debt,
  type DebtDecompositionTree,
  type DebtId,
  type DebtMutationResult,
  type DebtTreeNode,
} from "@astrosheep/keiyaku";
const world = null as unknown as import("@astrosheep/keiyaku").WorldRoot;
const debts = Debts.of(world);
const debt: Debt = debts.debt({ id: "debt/example" });
const id: DebtId = debt.id;
const result: Promise<DebtMutationResult> = debts.add({ title: "Example", state: "open", note: "initial" });
const tree: Promise<DebtDecompositionTree> = debt.tree();
const node = null as unknown as DebtTreeNode;
void debt.update({ note: "replacement" });
void debt.drop({ note: "obsolete" });
// @ts-expect-error Debt has no static construction surface
Debt.at({ path: "." });
// @ts-expect-error callers do not choose IDs during creation
debts.add({ id: "debt/chosen", title: "Chosen" });
// @ts-expect-error tree accepts no full option
void debt.tree({ full: true });
// @ts-expect-error the removed execution carrier is not a public input
Debts.of(world, { execution: {} });
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
