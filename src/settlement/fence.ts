import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  acquireSqliteTransactionLock,
  type HeldSqliteTransactionLock,
} from "../coordination/sqlite-transaction-lock.js";
import { commonGitDirectory } from "../git/repository.js";
import type { GitRepository } from "../git/process.js";
import type { TaskId } from "../task/identity.js";

export function settlementFencePath(repository: GitRepository, taskId: TaskId): string {
  const locator = createHash("sha256").update(taskId).digest("hex");
  return resolve(commonGitDirectory(repository), "keiyaku", "locks", "settlement", `${locator}.sqlite`);
}

export function acquireTaskSettlementFence(
  repository: GitRepository,
  taskId: TaskId,
): Promise<HeldSqliteTransactionLock> {
  return acquireSqliteTransactionLock({
    path: settlementFencePath(repository, taskId),
    mode: "immediate",
  });
}
