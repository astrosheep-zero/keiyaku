import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { serializeDebtDocument, type DebtDocument } from "../../src/debt/document.js";
import { parseDebtId, debtAuthorityPath, type DebtId } from "../../src/debt/identity.js";
import type { WorldRoot } from "../../src/world.js";

/** The physical Debt authority path a World gives one Debt identity. */
export function debtAuthorityFile(world: WorldRoot, id: DebtId): string {
  return debtAuthorityPath(resolve(world, ".keiyaku", "debts"), parseDebtId(id));
}

export function debtDocument(
  input: Readonly<{
    id: DebtId;
    title: string;
    state?: DebtDocument["state"];
    priority?: DebtDocument["priority"];
    needs?: DebtDocument["needs"];
    createdBy?: string;
    createdAt?: string;
    updatedAt?: string;
  }>,
): DebtDocument {
  return {
    id: input.id,
    title: input.title,
    body: "",
    note: "",
    state: input.state ?? "open",
    priority: input.priority ?? 2,
    needs: input.needs ?? [],
    parent: null,
    supersedes: [],
    relates: [],
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
    createdAt: input.createdAt ?? "2026-08-17T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-17T00:00:00.000Z",
  };
}

export function writeDebtAuthority(world: WorldRoot, document: DebtDocument): void {
  const path = debtAuthorityFile(world, document.id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeDebtDocument(document));
}
