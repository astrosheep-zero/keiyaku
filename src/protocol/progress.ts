import { contractIdSchema, snapshotIdSchema } from "../git/identity.js";
import { z } from "zod";
import { worktreeLeakSchema } from "../git/scratch.js";
import { privateStateSeatCloseLagSchema } from "../git/private-state-seat.js";
import { verificationCleanupFailureSchema } from "./intent.js";
import type { ContractHead, ContractId, ContractState, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { GitPlumbingError } from "../git/process.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { WorktreeLeak } from "../git/scratch.js";
import { GitPrivateStateSeatContentionError, type PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { VerificationCleanupFailure } from "./intent.js";
import type { AcceptedProtocolStep } from "./outcome.js";
import type { ExecutionObservation } from "./execution-observation.js";
import type { CandidateCompletion, CompletionEvidence } from "./completion.js";

/** A captured interpretation is not an invocation's admission receipt. */
export type ContractCheckpoint = Readonly<{ state: ContractState; journal: readonly JournalEntry[] }>;

export function contractCheckpoint(input: ContractCheckpoint): ContractCheckpoint {
  return { state: input.state, journal: input.journal };
}

export const executionCleanupSchema = z.union([
  z
    .object({
      kind: z.literal("decode-channel-retirement"),
      contractId: contractIdSchema,
      diagnostic: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("verification-cleanup"),
      contractId: contractIdSchema,
      snapshot: snapshotIdSchema.optional(),
      failure: verificationCleanupFailureSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("worktree-leak"),
      contractId: contractIdSchema,
      snapshot: snapshotIdSchema.optional(),
      leak: worktreeLeakSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("private-state-seat-close"),
      contractId: contractIdSchema,
      failure: privateStateSeatCloseLagSchema,
    })
    .strict(),
]);
export type ExecutionCleanup = z.infer<typeof executionCleanupSchema>;
export const executionStageSchema = z.enum([
  "admission",
  "verification",
  "placement",
  "reintegration",
  "continuation",
  "reconciliation",
]);
export type ExecutionStage = z.infer<typeof executionStageSchema>;
export const executionStopSchema = z
  .object({
    kind: z.literal("execution-stopped"),
    contractId: contractIdSchema,
    stage: executionStageSchema,
    reason: z.enum(["cancelled", "failed"]),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict();
export type ExecutionStop = z.infer<typeof executionStopSchema>;
/** Only owner-declared operational classes and native system I/O failures are operational. */
export function isOperationalFailure(error: unknown): error is Error {
  if (
    !(error instanceof Error) ||
    error instanceof AuthorityCorruptionError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  )
    return false;
  return (
    error instanceof GitPlumbingError ||
    error instanceof SqliteTransactionLockError ||
    error instanceof GitPrivateStateSeatContentionError ||
    ("code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/u.test(error.code))
  );
}

/** Cancellation is witnessed by this exact signal reason, not by a signal merely being aborted. */
export function isOperationalStop(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted === true && error === signal.reason) return true;
  if (
    error instanceof AuthorityCorruptionError ||
    error instanceof TypeError ||
    error instanceof RangeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError
  )
    return false;
  return isOperationalFailure(error);
}

/** Classify operational failures only; programming errors and corrupt authority still throw. */
export function executionStop(
  contractId: ContractId,
  stage: ExecutionStage,
  error: unknown,
  signal?: AbortSignal,
): ExecutionStop {
  const cancelled =
    signal?.aborted === true &&
    (error === signal.reason || error instanceof GitPlumbingError || error instanceof SqliteTransactionLockError);
  if (!cancelled && !isOperationalFailure(error)) throw error;
  return {
    kind: "execution-stopped",
    contractId,
    stage,
    reason: cancelled ? "cancelled" : "failed",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

/** Physical residue and custodial residue a leading admission or reconciliation step reports. */
export type ProgressResidue = Readonly<{
  physical?: ReconcileResult;
  seatClose?: readonly PrivateStateSeatCloseLag[];
}>;

export type VerificationResidue = Readonly<{ cleanup?: VerificationCleanupFailure; leak?: WorktreeLeak }>;

/**
 * The narrow lower sink an invocation offers to protocol operations. Operation nodes report
 * observations here and never assemble a public result.
 */
export interface ProtocolProgress {
  observe(event: ExecutionObservation): void;
  recordPublication(contractId: ContractId, head: ContractHead, facts: readonly JournalEntry[]): void;
  recordAdmission(step: AcceptedProtocolStep): void;
  recordResidue(contractId: ContractId, residue: ProgressResidue): void;
  recordPhysical(contractId: ContractId, report: ReconcileResult): void;
  /** Physical follow owned by this invocation's target movement, distinct from retained topology. */
  recordPlacementPhysical(contractId: ContractId, report: ReconcileResult): void;
  recordVerification(contractId: ContractId, snapshot: SnapshotId | undefined, result: VerificationResidue): void;
  recordStop(stop: ExecutionStop): void;
  recordAudit(contractId: ContractId, report: Partial<import("./audit.js").AuditReport>): void;
  /** Current candidate conclusions, retained before the next await can fail. */
  recordCandidate(contractId: ContractId, evidence: CompletionEvidence): void;
  /** The candidate's completion base, retained before an optional scope read can fail. */
  recordCompletion(contractId: ContractId, completion: CandidateCompletion): void;
  checkpoint(contractId: ContractId): ContractCheckpoint | undefined;
  hasFact(fact: JournalEntry): boolean;
  head(contractId: ContractId): ContractHead | undefined;
}
