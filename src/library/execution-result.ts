import { decodeJournalEntry } from "../core/facts/codec.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import {
  contractHead,
  contractId,
  snapshotId,
  type ContractHead,
  type ContractId,
  type JournalEntry,
} from "../core/facts/types.js";
import { decodePrivateStateSeatCloseLag, decodeWorktreeLeak } from "../git/result-codec.js";
import type { ExecutionCleanup, ExecutionProgress, ExecutionStop } from "../protocol/progress.js";
import { decodeVerificationCleanupFailure } from "../protocol/result-codec.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

export const mutationOperationSchema = z.enum(["bind", "amend", "deliver", "review", "audit", "arc", "abandon"]);
export type MutationOperation = z.infer<typeof mutationOperationSchema>;
export type { ExecutionCleanup, ExecutionStop } from "../protocol/progress.js";
const contractSchema = ownerSchema((value) => {
  if (typeof value !== "string") throw new Error("expected contract identity");
  return contractId(value);
}, "expected contract identity");
const snapshotSchema = ownerSchema((value) => {
  if (typeof value !== "string") throw new Error("expected snapshot identity");
  return snapshotId(value);
}, "expected snapshot identity");

export const executionCleanupSchema = z.union([
  z
    .object({
      kind: z.literal("verification-cleanup"),
      contractId: contractSchema,
      snapshot: snapshotSchema.optional(),
      failure: ownerSchema(decodeVerificationCleanupFailure, "expected cleanup failure"),
    })
    .strict()
    .transform(({ snapshot, ...rest }) => (snapshot === undefined ? rest : { ...rest, snapshot })),
  z
    .object({
      kind: z.literal("worktree-leak"),
      contractId: contractSchema,
      snapshot: snapshotSchema.optional(),
      leak: ownerSchema(decodeWorktreeLeak, "expected worktree leak"),
    })
    .strict()
    .transform(({ snapshot, ...rest }) => (snapshot === undefined ? rest : { ...rest, snapshot })),
  z
    .object({
      kind: z.literal("private-state-seat-close"),
      contractId: contractSchema,
      failure: ownerSchema(decodePrivateStateSeatCloseLag, "expected seat close failure"),
    })
    .strict(),
]) satisfies z.ZodType<ExecutionCleanup>;

export const executionStopSchema = z
  .object({
    kind: z.literal("execution-stopped"),
    contractId: contractSchema,
    stage: z.enum(["admission", "verification", "placement", "reintegration", "continuation", "reconciliation"]),
    reason: z.enum(["cancelled", "failed"]),
    diagnostic: z.string(),
  })
  .strict() satisfies z.ZodType<ExecutionStop>;

/** Confirmed facts accompanying an exceptional outcome; not a completed mutation answer. */
export type ExecutionReceipt = Readonly<{
  operation: MutationOperation;
  contractId: ContractId;
  head: ContractHead;
  facts: readonly JournalEntry[];
  cleanup: readonly ExecutionCleanup[];
  executionStops: readonly ExecutionStop[];
}>;

export const executionReceiptSchema = z
  .object({
    operation: mutationOperationSchema,
    contractId: contractSchema,
    head: ownerSchema((value) => {
      if (typeof value !== "string") throw new Error("expected contract head");
      return contractHead(value);
    }, "expected contract head"),
    facts: z.array(ownerSchema(decodeJournalEntry, "expected journal entry")),
    cleanup: z.array(executionCleanupSchema),
    executionStops: z.array(executionStopSchema),
  })
  .strict() satisfies z.ZodType<ExecutionReceipt>;

export function receiptFromProgress(
  operation: MutationOperation,
  contractId: ContractId,
  progress: ExecutionProgress,
): ExecutionReceipt | undefined {
  const head = progress.head(contractId);
  if (head === undefined) return undefined;
  const snapshot = progress.snapshot();
  return {
    operation,
    contractId,
    head,
    facts: snapshot.facts,
    cleanup: snapshot.cleanup,
    executionStops: snapshot.stops,
  };
}

/** Preserve the error category and the confirmed receipt instead of disguising failure as refusal. */
export function withExecutionReceipt(error: unknown, receipt: ExecutionReceipt): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const retained = Object.isExtensible(original)
    ? original
    : original instanceof AuthorityCorruptionError
      ? new AuthorityCorruptionError(original.message, { cause: original })
      : original instanceof TypeError
        ? new TypeError(original.message, { cause: original })
        : new Error(original.message, { cause: original });
  Object.defineProperty(retained, "executionReceipt", { value: receipt, enumerable: true, configurable: true });
  return retained;
}

export function executionReceipt(error: unknown): ExecutionReceipt | undefined {
  if (error === null || typeof error !== "object" || !("executionReceipt" in error)) return undefined;
  const parsed = executionReceiptSchema.safeParse(error.executionReceipt);
  return parsed.success ? parsed.data : undefined;
}
