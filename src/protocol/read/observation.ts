import { observeWorktreeHookMarker } from "../../git/hooks.js";
import type { GitRepository } from "../../git/process.js";
import { registeredWorktrees, worktreeGitDirectory } from "../../git/repository.js";
import { observeTargetCheckoutShape } from "../../git/target-placement.js";
import type { ContractRow } from "./status.js";

export type CurrentPhysicalIssue =
  | Readonly<{ kind: "hook-failure"; diagnostic: string }>
  | Readonly<{ kind: "target-checkout-retained"; target: string }>;

function appointedWorkspacePath(row: ContractRow, hereWorkspacePath?: string): string | null {
  if (hereWorkspacePath !== undefined) return hereWorkspacePath;
  const observation = row.workspaceObservation;
  if (observation.kind !== "clean" && observation.kind !== "dirty") return null;
  return observation.location.kind === "worktree" ? observation.location.path : null;
}

/** Selected-only pure projection of durable hook failure or retained target checkout. */
export async function observeCurrentPhysicalIssue(
  repository: GitRepository,
  row: ContractRow,
  hereWorkspacePath?: string,
): Promise<CurrentPhysicalIssue | undefined> {
  const workspacePath = appointedWorkspacePath(row, hereWorkspacePath);
  if (workspacePath !== null) {
    const marker = await observeWorktreeHookMarker(await worktreeGitDirectory(repository, workspacePath));
    if (marker.kind === "failed") return { kind: "hook-failure", diagnostic: marker.diagnostic };
  }
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
