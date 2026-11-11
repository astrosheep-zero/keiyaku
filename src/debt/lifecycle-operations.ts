import { serializeDebtDocument, type DebtDocument } from "./document.js";
import type { SettledDebtResult } from "./operation-types.js";
import type { DebtId } from "./identity.js";
import { readBoard, replaceAuthority, withDebtLocks } from "./store.js";
import type { WorldRoot } from "../world.js";
import { advanceDebtTimestamp } from "./view.js";

export async function settleDebt(world: WorldRoot, id: DebtId): Promise<SettledDebtResult> {
  const result = await withDebtLocks({ world, allocation: false, ids: [id] }, async (): Promise<SettledDebtResult> => {
    const snapshot = await readBoard(world),
      current = snapshot.board.debts.get(id);
    if (current === undefined) return { kind: "refused", reason: "debt-missing" };
    if (current.state === "done") return { kind: "unchanged" };
    if (current.state === "drop") {
      return {
        kind: "refused",
        reason: "invalid-lifecycle-transition",
        state: current.state,
      };
    }
    const next: DebtDocument = {
      ...current,
      state: "done",
      updatedAt: advanceDebtTimestamp(current.updatedAt, new Date().toISOString()),
    };
    const replaced = await replaceAuthority({
      world,
      id,
      expected: snapshot.bytes.get(id)!,
      next: serializeDebtDocument(next),
    });
    return replaced === "replaced" ? { kind: "changed" } : { kind: "retry", reason: "concurrent-modification" };
  });
  return result === "busy" ? { kind: "retry", reason: "busy" } : result;
}
