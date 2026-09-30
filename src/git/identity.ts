import { z } from "zod";
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

// Structural admission reuses the pure identity constructors; physical minting remains distinct.
export const contractIdSchema = z.string().transform((value, context) => {
  try {
    return contractId(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid contractId" });
    return z.NEVER;
  }
});
export const snapshotIdSchema = z.string().transform((value, context) => {
  try {
    return snapshotId(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid snapshotId" });
    return z.NEVER;
  }
});
export const contractHeadSchema = z.string().transform((value, context) => {
  try {
    return contractHead(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid ContractHead" });
    return z.NEVER;
  }
});
export const changeIdSchema = z.string().transform((value, context) => {
  try {
    return changeId(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid changeId" });
    return z.NEVER;
  }
});
export const mintedSnapshotInputSchema = z.string().transform((value, context) => {
  try {
    return mintSnapshotId(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid mintSnapshotId" });
    return z.NEVER;
  }
});

declare const gitObjectIdBrand: unique symbol;

export type GitObjectId = string & { readonly [gitObjectIdBrand]: "GitObjectId" };

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
function locator(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function contractLocator(contract: ContractId): string {
  return locator(contractId(contract));
}

export function gitRefLocator(ref: string): string {
  if (ref.length === 0) throw new Error("Git ref locator input must be nonempty");
  return locator(ref);
}

export function contractPhysicalName(contract: ContractId): string {
  return contractId(contract).replace("/", "-");
}

function contractJournalSuffix(contract: ContractId): string {
  const digest = contractLocator(contract);
  return `${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest.slice(4)}.jsonl`;
}

export type ContractJournalClass = "active" | "terminal";

export function contractJournalPath(contract: ContractId, journalClass: ContractJournalClass = "active"): string {
  return `contracts/${journalClass}/${contractJournalSuffix(contract)}`;
}

export function contractJournalPaths(contract: ContractId): readonly string[] {
  return [contractJournalPath(contract, "active"), contractJournalPath(contract, "terminal")];
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
