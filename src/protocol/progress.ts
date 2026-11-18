import { z } from "zod";
import type { ContractHead, ContractId, ContractState, JournalEntry, SnapshotId } from "../core/facts/types.js";
import { AuthorityCorruptionError } from "../core/facts/errors.js";
import { GitPlumbingError } from "../git/process.js";
import { SqliteTransactionLockError } from "../coordination/sqlite-transaction-lock.js";
import type { ReconcileResult } from "../git/reconcile.js";
import type { WorktreeLeak } from "../git/scratch.js";
import { GitPrivateStateSeatContentionError, type PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { AcceptedProtocolStep } from "./outcome.js";
import type { ExecutionObservation } from "./execution-observation.js";
import type { VerificationCheck } from "./verify.js";
import type { Placed, Placement } from "./completion.js";
import type { executionIssueSchema } from "./result-reasons.js";

/** A captured interpretation is not an invocation's admission receipt. */
export type ContractCheckpoint = Readonly<{ state: ContractState; journal: readonly JournalEntry[] }>;

export function contractCheckpoint(input: ContractCheckpoint): ContractCheckpoint {
  return { state: input.state, journal: input.journal };
}

export const verificationCleanupFailureSchema = z
  .object({
    name: z.string().refine((value) => value.trim() !== ""),
    diagnostic: z.string().refine((value) => value.trim() !== ""),
  })
  .strict()
  .readonly();
export type VerificationCleanupFailure = z.infer<typeof verificationCleanupFailureSchema>;

type ExecutionIssue = z.output<typeof executionIssueSchema>;
export type ExecutionStop = ExecutionIssue & Readonly<{ contractId: ContractId }>;
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
  return isOperationalFailure(error);
}

/** Classify operational failures only; programming errors and corrupt authority still throw. */
export function executionIssue(error: unknown, signal?: AbortSignal): ExecutionIssue {
  const cancelled =
    signal?.aborted === true &&
    (error === signal.reason || error instanceof GitPlumbingError || error instanceof SqliteTransactionLockError);
  if (!cancelled && !isOperationalFailure(error)) throw error;
  return {
    kind: "execution-stopped",
    reason: cancelled ? "cancelled" : "failed",
    diagnostic: error instanceof Error ? error.message : String(error),
  };
}

export function executionStop(contractId: ContractId, error: unknown, signal?: AbortSignal): ExecutionStop {
  return { contractId, ...executionIssue(error, signal) };
}

/** Physical residue and custodial residue a leading admission or reconciliation step reports. */
export type ProgressResidue = Readonly<{
  physical?: ReconcileResult;
  seatClose?: readonly PrivateStateSeatCloseLag[];
}>;

export type VerificationResidue = Readonly<{ cleanup?: VerificationCleanupFailure; leak?: WorktreeLeak }>;

/**
 * The narrow sink for protocol operations to retain confirmed evidence and native conclusions.
 * It does not decide currentness or assemble the invocation result.
 */
export interface ProtocolProgress {
  observe(event: ExecutionObservation): void;
  recordPublication(contractId: ContractId, head: ContractHead, facts: readonly JournalEntry[]): void;
  recordAdmission(step: AcceptedProtocolStep): void;
  recordResidue(contractId: ContractId, residue: ProgressResidue): void;
  recordPhysical(contractId: ContractId, report: ReconcileResult): void;
  /** Physical follow owned by this invocation's target movement, distinct from retained topology. */
  recordPlacementPhysical(contractId: ContractId, report: ReconcileResult): void;
  recordVerification(
    contractId: ContractId,
    snapshot: SnapshotId | undefined,
    result: VerificationResidue,
    coordinate?: Readonly<{ requirement: string; index: number }>,
  ): void;
  recordVerificationCheck(contractId: ContractId, snapshot: SnapshotId, check: VerificationCheck): void;
  recordStop(stop: ExecutionStop): void;
  recordDeliveryPreview(
    contractId: ContractId,
    report: Partial<import("./delivery-preview.js").DeliveryPreviewReport>,
  ): void;
  recordDelivery(contractId: ContractId, value: import("./deliver.js").DeliveryIdentity): void;
  /** Current candidate conclusions, retained before the next await can fail. */
  recordCandidate(contractId: ContractId, placement: Placement | undefined): void;
  /** Retain and return the admitted movement, including before a target checkout follows. */
  recordCompletion(contractId: ContractId, movement: Omit<Placed, "kind">): Placed;
  checkpoint(contractId: ContractId): ContractCheckpoint | undefined;
  hasFact(fact: JournalEntry): boolean;
  head(contractId: ContractId): ContractHead | undefined;
}
