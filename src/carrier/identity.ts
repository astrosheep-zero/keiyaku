import { randomBytes } from "node:crypto";
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
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Mint the current carrier's opaque contract coordinate for one bind invocation. */
export function mintContractId(): ContractId {
  let timestamp = BigInt(Date.now());
  let value = "";
  for (let index = 0; index < 10; index += 1) {
    value = CROCKFORD_BASE32[Number(timestamp & 31n)]! + value;
    timestamp >>= 5n;
  }
  let random = BigInt(`0x${randomBytes(10).toString("hex")}`);
  for (let index = 0; index < 16; index += 1) {
    value += CROCKFORD_BASE32[Number(random & 31n)]!;
    random >>= 5n;
  }
  return contractId(`kei/${value.toLowerCase()}`);
}

/** Project a public contract identity into this carrier's private journal layout. */
export function contractJournalPath(contract: ContractId): string {
  const id = contractId(contract);
  return `contracts/${id.slice("kei/".length)}.jsonl`;
}

/** The current Git carrier is the only physical object-ID validation boundary. */
export function gitObjectId(value: string, label = "Git object ID"): GitObjectId {
  if (!GIT_OBJECT_ID.test(value)) throw new TypeError(`${label} is not a Git object ID: ${value}`);
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
