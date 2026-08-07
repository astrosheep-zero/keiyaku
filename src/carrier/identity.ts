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
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function fanoutHash(value: string, seed: bigint): string {
  let state = seed;
  for (let index = 0; index < value.length; index += 1) {
    state = ((state ^ BigInt(value.charCodeAt(index)!)) * FNV_PRIME) & FNV_MASK;
  }
  return state.toString(16).padStart(16, "0");
}

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

export function contractJournalPath(contract: ContractId): string {
  const id = contractId(contract);
  const fanout = fanoutHash(id, 0xcbf29ce484222325n).slice(0, 4);
  return `contracts/${fanout.slice(0, 2)}/${fanout.slice(2, 4)}/${id.slice("kei/".length)}.jsonl`;
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
