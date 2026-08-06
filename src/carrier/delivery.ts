import type { ContractId, DeliverData } from "../core/facts/types.js";
import { mintChangeId, mintSnapshotId, gitObjectIdForSnapshot } from "./identity.js";
import { observeContract } from "./observe.js";
import { readRef, runGit, type GitRepository } from "./repository.js";
import { deliveryWorktreePath } from "./reconcile.js";

export type DeliveryPreparation =
  | Readonly<{
    kind: "prepared";
    delivery: DeliverData;
  }>
  | Readonly<{ kind: "refused"; refusal: unknown }>;

/** Prepare the Git-backed tender; pact receives only its opaque identities. */
export function prepareDelivery(repository: GitRepository, id: ContractId): DeliveryPreparation {
  const current = observeContract(repository, id).state;
  if (!current) return { kind: "refused", refusal: { kind: "contract-missing", contractId: id } };
  if (!current.bound) return { kind: "refused", refusal: { kind: "not-bound", contractId: id } };
  if (current.terminal) return { kind: "refused", refusal: { kind: "terminal", contractId: id } };

  const coordinates = current.coordinates;
  if (coordinates === null) throw new TypeError("bound contract is missing coordinates");
  const observedTarget = coordinates.target === undefined ? null : readRef(repository, coordinates.target);
  if (coordinates.target !== undefined && observedTarget === null) {
    return { kind: "refused", refusal: { kind: "target-missing", contractId: id } };
  }
  const predecessor = observedTarget === null ? coordinates.start : mintSnapshotId(observedTarget);
  const workspace = coordinates.workspace === "worktree" ? deliveryWorktreePath(repository, id) : repository.effectiveCwd;
  const candidate = mintSnapshotId(runGit(repository, ["-C", workspace, "rev-parse", "HEAD"]).toString("utf8").trim());

  if (coordinates.target !== undefined) {
    try {
      runGit(repository, ["merge-base", "--is-ancestor", gitObjectIdForSnapshot(predecessor), gitObjectIdForSnapshot(candidate)]);
    } catch (error) {
      const status = (error as { status?: number | null }).status;
      if (status === 1) return { kind: "refused", refusal: { kind: "candidate-not-based-on-target", contractId: id } };
      throw error;
    }
  }

  const diff = runGit(repository, ["diff", "--binary", gitObjectIdForSnapshot(predecessor), gitObjectIdForSnapshot(candidate)]);
  const output = runGit(repository, ["patch-id", "--stable"], diff).toString("utf8").trim();
  const separator = output.indexOf(" ");
  // Git emits no patch-id for an empty diff, so use Git's content identity for those same bytes.
  const identity = output.length === 0
    ? runGit(repository, ["hash-object", "-t", "blob", "--stdin"], diff).toString("utf8").trim()
    : separator < 0 ? output : output.slice(0, separator);
  return {
    kind: "prepared",
    delivery: {
      expectedPredecessor: predecessor,
      candidate,
      deliveryPatchId: mintChangeId(identity),
    },
  };
}
