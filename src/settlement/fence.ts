import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
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

/** Remove only the hash-addressed settlement fences owned by Contract/Git reset. */
export async function nukeSettlementFences(repository: GitRepository): Promise<void> {
  const root = resolve(commonGitDirectory(repository), "keiyaku", "locks", "settlement");
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}\.sqlite$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Settlement fence custody is invalid: ${resolve(root, entry.name)}`);
    }
  }
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    const held = await acquireSqliteTransactionLock({ path, mode: "immediate" });
    held.close();
  }
}
