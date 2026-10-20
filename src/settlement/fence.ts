import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  acquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { commonGitDirectory } from "../git/repository.js";
import type { GitRepository } from "../git/process.js";
import type { DebtId } from "../debt/identity.js";

export function settlementFencePath(repository: GitRepository, debtId: DebtId): string {
  const locator = createHash("sha256").update(debtId).digest("hex");
  return resolve(commonGitDirectory(repository), "keiyaku", "locks", "settlement", `${locator}.sqlite`);
}

export function acquireDebtSettlementFence(
  repository: GitRepository,
  debtId: DebtId,
): Promise<HeldSqliteTransactionLock> {
  return acquireSqliteTransactionLock({
    path: settlementFencePath(repository, debtId),
    mode: "immediate",
  });
}
