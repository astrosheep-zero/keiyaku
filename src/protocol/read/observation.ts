import type { GitRepository } from "../../git/process.js";
import { registeredWorktrees } from "../../git/repository.js";
import { observeTargetCheckoutShape } from "../../git/target-placement.js";
import type { ContractRow } from "./status.js";

export type CurrentPhysicalIssue = Readonly<{ kind: "target-checkout-retained"; target: string }>;

/** Selected-only pure projection of retained target checkout state. */
export async function observeCurrentPhysicalIssue(
  repository: GitRepository,
  row: ContractRow,
): Promise<CurrentPhysicalIssue | undefined> {
  const target = row.target;
  const delivery = row.delivery;
  if (row.phase !== "claimed" || target === null || delivery === null) return undefined;
  if (row.targetObservation?.head !== delivery.integration.snapshot) return undefined;
  const worktrees = (await registeredWorktrees(repository))
    .filter((worktree) => worktree.branch === target)
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const worktree of worktrees) {
    const shape = await observeTargetCheckoutShape(repository, {
      path: worktree.path,
      predecessor: delivery.integration.predecessor,
      candidate: delivery.integration.snapshot,
    });
    if (shape === "retained") return { kind: "target-checkout-retained", target };
  }
  return undefined;
}
