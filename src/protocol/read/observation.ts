import { z } from "zod";
import { type ContractState, type SnapshotId } from "../../core/facts/types.js";
import type { GitRepository } from "../../git/process.js";
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
  const shape = await observeTargetCheckoutShape(repository, { target, predecessor, candidate: delivery.integration });
  return shape === "retained" ? { kind: "target-checkout-retained" } : undefined;
}
