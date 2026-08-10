import { createHash } from "node:crypto";
import {
  changeId,
  contractHead,
  contractId,
  snapshotId,
  type ChangeId,
  type ContractHead,
  type ContractId,
  type SnapshotId,
} from "../core/facts/types.js";

declare const gitObjectIdBrand: unique symbol;

export type GitObjectId = string & { readonly [gitObjectIdBrand]: "GitObjectId" };

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function contractJournalPath(contract: ContractId): string {
  const id = contractId(contract);
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  return `contracts/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest.slice(4)}.jsonl`;
}

export function gitObjectId(value: string, label = "Git object ID"): GitObjectId {
  if (!GIT_OBJECT_ID.test(value)) throw new Error(`${label} is not a Git object ID: ${value}`);
  return value as GitObjectId;
}

export function mintSnapshotId(value: string): SnapshotId {
  return snapshotId(gitObjectId(value, "snapshot"));
}

export function mintChangeId(value: string): ChangeId {
  return changeId(gitObjectId(value, "change"));
}

export function mintContractHead(value: string): ContractHead {
  return contractHead(gitObjectId(value, "contract head"));
}

export function gitObjectIdForSnapshot(value: SnapshotId): GitObjectId {
  return gitObjectId(value, "snapshot");
}
