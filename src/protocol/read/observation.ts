import { z } from "zod";
import { type ContractState, type SnapshotId } from "../../core/facts/types.js";
import type { GitRepository } from "../../git/process.js";
import { registeredWorktrees } from "../../git/repository.js";
import { resolveContractTarget } from "../../git/target.js";
import { observeTargetCheckoutShape } from "../../git/target-placement.js";
import type { ContractDetail } from "./status.js";

export const currentPhysicalIssueSchema = z.strictObject({ kind: z.literal("target-checkout-retained") }).readonly();
export type CurrentPhysicalIssue = z.output<typeof currentPhysicalIssueSchema>;

/** Selected-only pure projection of retained target checkout state. */
export async function observeCurrentPhysicalIssue(
  repository: GitRepository,
  row: Readonly<{
    phase: ContractDetail["phase"];
    target: ContractState["coordinates"]["target"];
    delivery: ContractDetail["delivery"];
    observedHead: SnapshotId | null;
  }>,
  predecessor?: SnapshotId,
): Promise<CurrentPhysicalIssue | undefined> {
  const target = row.target;
  const delivery = row.delivery;
  if (row.phase !== "claimed" || target === undefined || delivery === undefined || predecessor === undefined)
    return undefined;
  if (row.observedHead !== delivery.integration) return undefined;
  let worktrees: readonly Readonly<{ path: string }>[];
  if (typeof target === "string") {
    worktrees = (await registeredWorktrees(repository))
      .filter((worktree) => worktree.branch === target)
      .sort((left, right) => left.path.localeCompare(right.path));
  } else {
    const resolved = await resolveContractTarget(repository, target.contractId, target);
    if (resolved.kind === "refused") return { kind: "target-checkout-retained" };
    worktrees = [{ path: resolved.path }];
  }
  for (const worktree of worktrees) {
    const shape = await observeTargetCheckoutShape(repository, {
      path: worktree.path,
      predecessor,
      candidate: delivery.integration,
    });
    if (shape === "retained") return { kind: "target-checkout-retained" };
  }
  return undefined;
}
