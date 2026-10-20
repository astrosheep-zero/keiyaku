import type { BoundedList } from "../bounded-list.js";
import type { DebtRef, DebtRow } from "./board.js";
import type { DebtDocument } from "./document.js";
import { isDebtSegment, parseDebtId, type DebtId } from "./identity.js";
import { readRecentDebtDocuments, readDebtDocument } from "./store.js";
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

export type RecentDebtStatusRow = DebtRow & Readonly<{ blockers?: readonly DebtRef[] }>;

async function catalogRow(
  world: WorldRoot,
  debt: DebtDocument,
  documents: ReadonlyMap<DebtId, DebtDocument>,
): Promise<RecentDebtStatusRow> {
  const needs = await Promise.all(
    debt.needs.map(async (id) => documents.get(id) ?? (await readDebtDocument(world, id))),
  );
  const blockers: DebtRef[] = [];
  if (debt.state === "open") {
    for (const [index, need] of needs.entries()) {
      if (terminal(need)) continue;
      blockers.push({ id: debt.needs[index]!, title: need?.title ?? null, state: need?.state ?? "missing" });
    }
  }
  return {
    id: debt.id,
    title: debt.title,
    state: debt.state,
    priority: debt.priority,
    disposition:
      debt.state === "open" && needs.some((need) => !terminal(need))
        ? "blocked"
        : debt.state === "open"
          ? "ready"
          : debt.state,
    updatedAt: debt.updatedAt,
    bodyPresent: debt.body.length > 0,
    ...(blockers.length === 0 ? {} : { blockers }),
  };
}

export async function observeRecentDebtStatus(
  world: WorldRoot,
  input: Readonly<{ namespace?: readonly string[]; limit?: number }> = {},
): Promise<BoundedList<RecentDebtStatusRow>> {
  const { namespace } = input;
  if (namespace !== undefined && !namespace.every(isDebtSegment)) {
    throw new TypeError("namespace must contain canonical segments");
  }
  const documents = await readRecentDebtDocuments(world, {
    ...(namespace === undefined ? {} : { namespace }),
    selection: "active",
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
  const known = new Map(documents.rows.map((document) => [document.id, document]));
  return {
    rows: await Promise.all(documents.rows.map((document) => catalogRow(world, document, known))),
    hasMore: documents.hasMore,
  };
}
