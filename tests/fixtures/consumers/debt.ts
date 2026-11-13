import { Debts, Keiyaku, World, type DebtDetail, type DebtShowItem, type DebtShowResult, type DebtUpdateResult } from "@astrosheep/keiyaku";

const facet = Keiyaku.at({ cwd: "/tmp", environment: {} });
const catalogue = facet.ls({ selector: "debt/", selection: "all" });
const one = facet.show({ id: "debt/example" });
const completed: Promise<DebtUpdateResult> = facet.debtUpdate({ id: "debt/example", state: "done" });

async function native(world: import("@astrosheep/keiyaku").WorldRoot) {
  const debts = Debts.of(world);
  const debt = debts.debt({ id: "debt/example" });
  const batch: DebtShowResult = await debts.read({ ids: [debt.id, "debt/peer"] });
  await debt.read();
  await debt.tree();
  await debt.update({ note: "replacement" });
  return batch;
}
function firstFound(items: readonly DebtShowItem[]): DebtDetail | undefined {
  const first = items[0];
  return first?.kind === "found" ? first : undefined;
}
async function selectedTitles() {
  const result = await catalogue;
  return result.kind === "debt-catalogue" && !("absent" in result) ? result.rows?.map(row => row.title) : undefined;
}
void [one, completed, native, firstFound, selectedTitles, World];
