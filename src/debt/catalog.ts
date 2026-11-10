import type { BoundedList } from "../bounded-list.js";
import type { DebtSummary } from "./board.js";
import type { DebtDocument } from "./document.js";
import { isDebtSegment, parseDebtId, type DebtId } from "./identity.js";
import { readRecentDebtDocuments, readDebtDocument, type OpenDebtDocument } from "./store.js";
import type { WorldRoot } from "../world.js";

export function parseDebtNamespaceSelector(value: string): readonly string[] {
  if (value === "debt/") return [];
  if (!value.startsWith("debt/") || !value.endsWith("/")) {
    throw new TypeError(`invalid Debt namespace selector: ${value}`);
  }
  const body = value.slice("debt/".length, -1);
  const segments = body.split("/");
  if (body.length === 0 || !segments.every(isDebtSegment)) {
    throw new TypeError(`invalid Debt namespace selector: ${value}`);
  }
  return parseDebtId(`debt/${body}/placeholder`).namespace;
}

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
  input: Readonly<{ namespace?: readonly string[]; limit?: number }> = {},
): Promise<BoundedList<RecentDebtSummary>> {
  const { namespace } = input;
  if (namespace !== undefined && !namespace.every(isDebtSegment)) {
    throw new TypeError("namespace must contain canonical segments");
  }
  const documents = await readRecentDebtDocuments(world, {
    ...(namespace === undefined ? {} : { namespace }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const known = new Map(documents.rows.map((document) => [document.id, document]));
  return {
    rows: await Promise.all(documents.rows.map((document) => catalogRow(world, document, known))),
    hasMore: documents.hasMore,
  };
}
