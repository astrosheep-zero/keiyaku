import { parseDebtId } from "./identity.js";
import type { DebtDocument } from "./document.js";
import type { DebtView } from "./operation-types.js";

export function debtView(document: DebtDocument): DebtView {
  return { ...document, namespace: parseDebtId(document.id).namespace };
}

export function advanceDebtTimestamp(previous: string, candidate: string): string {
  return candidate > previous ? candidate : new Date(Date.parse(previous) + 1).toISOString();
}
