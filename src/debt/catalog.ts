import type { BoundedList } from "../bounded-list.js";
import type { DebtSummary } from "./board.js";
import type { DebtDocument } from "./document.js";
import { type DebtId } from "./identity.js";
import { readRecentDebtDocuments, readDebtDocument, type OpenDebtDocument } from "./store.js";
import type { WorldRoot } from "../world.js";

function terminal(debt: DebtDocument | undefined): boolean {
  return debt?.state === "done" || debt?.state === "drop";
}

export type RecentDebtSummary = Omit<DebtSummary, "disposition"> & Readonly<{ disposition: "ready" | "blocked" }>;

async function catalogRow(
  world: WorldRoot,
  debt: OpenDebtDocument,
  documents: ReadonlyMap<DebtId, DebtDocument>,
): Promise<RecentDebtSummary> {
  const needs = await Promise.all(
    debt.needs.map(async (id) => documents.get(id) ?? (await readDebtDocument(world, id))),
  );
  const blocked = needs.some((need) => !terminal(need));
  return {
    id: debt.id,
    title: debt.title,
    priority: debt.priority,
    disposition: blocked ? "blocked" : "ready",
  };
}

export async function observeRecentDebtStatus(
  world: WorldRoot,
  input: Readonly<{ limit?: number }> = {},
): Promise<BoundedList<RecentDebtSummary>> {
  const documents = await readRecentDebtDocuments(world, input);
  const known = new Map(documents.rows.map((document) => [document.id, document]));
  return {
    rows: await Promise.all(documents.rows.map((document) => catalogRow(world, document, known))),
    hasMore: documents.hasMore,
  };
}
