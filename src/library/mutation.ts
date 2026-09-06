import { ExecutionProgress, executionStop } from "../protocol/progress.js";
import {
  executionCleanupSchema,
  executionStopSchema,
  mutationOperationSchema,
  receiptFromProgress,
  withExecutionReceipt,
  type MutationOperation,
  type ExecutionCleanup,
  type ExecutionStop,
} from "./execution-result.js";
import { decodeJournalEntry } from "../core/facts/codec.js";
import {
  contractHead,
  snapshotId,
  type ContractHead,
  type ContractId,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { ReconcileReport } from "../protocol/reconcile.js";
import type { RepositoryScope } from "../protocol/operations.js";
import type { IntentOutcome } from "../protocol/operations.js";
import type { AcceptedObligations } from "../protocol/outcome.js";
import { decodeSettlementLag } from "../settlement/result-codec.js";
import type { SettlementReport } from "../settlement/settle.js";
import type { TaskHolderAdmission } from "../settlement/holder.js";
import type { WorktreeHooks } from "./configuration.js";
import { completeReconcile, decodeReconciliationLag, type ReconcileCompletion } from "./reconcile.js";
import { decodeAuditReport, type AuditReport } from "../protocol/audit.js";
import { decodeMaterializedConflict, type IntegrationConflictMaterialized } from "../protocol/deliver.js";
import { decodeReviewValue, type ReviewValue } from "../protocol/review.js";
import { decodeContinuationReport, type ContinuationReport } from "./continuation.js";
import { deliveryValueSchema, type DeliveryValue } from "./delivery.js";
import type { KeiyakuRefused, KeiyakuRetry } from "./refusal.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

export type MutationFinalitySurface =
  | "verification"
  | "placement"
  | "continuation"
  | "reconciliation"
  | "settlement"
  | "cleanup"
  | "execution";

export type MutationFinality =
  | Readonly<{ kind: "complete" }>
  | Readonly<{
      kind: "accepted-pending";
      pending: readonly Readonly<{ surface: MutationFinalitySurface; required: boolean }>[];
    }>
  | Readonly<{ kind: "not-admitted" }>;

type AcceptedFinalityInput = Readonly<{
  kind: "accepted";
  operation: MutationOperation;
  lags: MutationResult<unknown>["lags"];
  settlementLags: MutationResult<unknown>["settlementLags"];
  value?: unknown;
  cleanup: readonly ExecutionCleanup[];
  executionStops: readonly ExecutionStop[];
  /** Transport/display convenience only; never finality authority. */
  pending?: readonly MutationPendingSurface[];
}>;

export type MutationFinalityInput =
  | AcceptedFinalityInput
  | IntegrationConflictMaterialized
  | KeiyakuRefused
  | KeiyakuRetry;

function pendingSurface(surface: MutationFinalitySurface, required: boolean) {
  return { surface, required } as const;
}

export type MutationPendingSurface = Readonly<{ surface: MutationFinalitySurface; required: boolean }>;

export function decodeMutationPendingSurface(value: unknown): MutationPendingSurface {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed pending surface");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => key !== "surface" && key !== "required"))
    throw new Error("malformed pending surface");
  if (
    object.surface !== "verification" &&
    object.surface !== "placement" &&
    object.surface !== "continuation" &&
    object.surface !== "reconciliation" &&
    object.surface !== "settlement" &&
    object.surface !== "cleanup" &&
    object.surface !== "execution"
  )
    throw new Error("malformed pending surface");
  if (typeof object.required !== "boolean") throw new Error("malformed pending surface");
  return { surface: object.surface, required: object.required };
}

export const mutationPendingSurfaceSchema = ownerSchema(
  decodeMutationPendingSurface,
  "expected pending surface",
) satisfies z.ZodType<MutationPendingSurface>;

export type Review = ReviewValue & Readonly<{ continuation?: ContinuationReport }>;

export function decodeReview(value: unknown): Review {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed review");
  const { continuation, ...protocol } = value as Record<string, unknown>;
  const review = decodeReviewValue(protocol);
  return continuation === undefined ? review : { ...review, continuation: decodeContinuationReport(continuation) };
}

export const auditReportSchema = ownerSchema(
  decodeAuditReport,
  "expected audit report",
) satisfies z.ZodType<AuditReport>;
const reviewSchema = ownerSchema(decodeReview, "expected review") satisfies z.ZodType<Review>;
const materializedConflictSchema = ownerSchema(
  decodeMaterializedConflict,
  "expected materialized conflict",
) satisfies z.ZodType<IntegrationConflictMaterialized>;

export const mutationResultSchema = <Value>(
  operation: MutationOperation,
  value: z.ZodType<Value>,
): z.ZodType<MutationResult<Value>> =>
  ownerSchema((input): MutationResult<Value> => {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("malformed mutation result");
    const object = input as Record<string, unknown>;
    if (object.kind !== "accepted" || object.operation !== operation) throw new Error("malformed mutation result");
    if (typeof object.head !== "string") throw new Error("malformed mutation result");
    const parsedValue = value.safeParse(object.value);
    if (!parsedValue.success) throw new Error("malformed mutation result");
    if (
      !Array.isArray(object.facts) ||
      !Array.isArray(object.lags) ||
      !Array.isArray(object.settlementLags) ||
      !Array.isArray(object.cleanup) ||
      !Array.isArray(object.executionStops) ||
      !Array.isArray(object.pending)
    )
      throw new Error("malformed mutation result");
    const allowed = new Set([
      "kind",
      "operation",
      "facts",
      "head",
      "value",
      "lags",
      "settlementLags",
      "pending",
      "recoverySnapshot",
      "cleanup",
      "executionStops",
    ]);
    for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error("malformed mutation result");
    return {
      kind: "accepted",
      operation,
      cleanup: (object.cleanup as unknown[]).map((item) => executionCleanupSchema.parse(item)),
      executionStops: (object.executionStops as unknown[]).map((item) => executionStopSchema.parse(item)),
      facts: object.facts.map(decodeJournalEntry),
      head: contractHead(object.head),
      value: parsedValue.data,
      lags: object.lags.map(decodeReconciliationLag),
      settlementLags: object.settlementLags.map(decodeSettlementLag),
      pending: object.pending.map(decodeMutationPendingSurface),
      ...(object.recoverySnapshot === undefined
        ? {}
        : { recoverySnapshot: snapshotId(String(object.recoverySnapshot)) }),
    };
  }, "expected mutation result");

export const deliveryResultSchema = z.union([
  mutationResultSchema("deliver", deliveryValueSchema),
  materializedConflictSchema,
]) satisfies z.ZodType<MutationResult<DeliveryValue> | IntegrationConflictMaterialized>;
export const reviewResultSchema = mutationResultSchema("review", reviewSchema) satisfies z.ZodType<
  MutationResult<Review>
>;
export const auditResultSchema = mutationResultSchema("audit", auditReportSchema) satisfies z.ZodType<
  MutationResult<AuditReport>
>;

type ObligationPendingInput = Readonly<{
  lags: MutationResult<unknown>["lags"];
  settlementLags: MutationResult<unknown>["settlementLags"];
  cleanup: readonly ExecutionCleanup[];
  executionStops: readonly ExecutionStop[];
}>;

type CompletionPendingValue = Readonly<{
  verification?: unknown | undefined;
  placement?: unknown | undefined;
  continuation?: ContinuationReport | undefined;
}>;

export function noValuePending(_value?: unknown): readonly MutationPendingSurface[] {
  return [];
}

export function auditPending(value: AuditReport): readonly MutationPendingSurface[] {
  return value.verification.kind === "stopped" ? [pendingSurface("verification", true)] : [];
}

export function completionPending(value: CompletionPendingValue): readonly MutationPendingSurface[] {
  const pending: MutationPendingSurface[] = [];
  if (value.verification !== undefined) pending.push(pendingSurface("verification", true));
  if (value.placement !== undefined) pending.push(pendingSurface("placement", true));
  if (value.continuation !== undefined && value.continuation.stopped.length > 0) {
    pending.push(pendingSurface("continuation", true));
  }
  return pending;
}

export function obligationPending(input: ObligationPendingInput): readonly MutationPendingSurface[] {
  const pending: MutationPendingSurface[] = [];
  if (input.lags.length > 0) pending.push(pendingSurface("reconciliation", true));
  if (input.settlementLags.length > 0) pending.push(pendingSurface("settlement", true));
  if (input.cleanup.length > 0) {
    pending.push(pendingSurface("cleanup", false));
  }
  for (const stop of input.executionStops) {
    const surface: MutationFinalitySurface =
      stop.stage === "admission" ? "execution" : stop.stage === "reintegration" ? "placement" : stop.stage;
    pending.push(pendingSurface(surface, true));
  }
  return pending;
}

export function collectAcceptedPending(
  valuePending: readonly MutationPendingSurface[],
  obligations: ObligationPendingInput,
): readonly MutationPendingSurface[] {
  const result = new Map<MutationFinalitySurface, boolean>();
  for (const pending of [...valuePending, ...obligationPending(obligations)])
    result.set(pending.surface, pending.required || result.get(pending.surface) === true);
  return [...result].map(([surface, required]) => ({ surface, required }));
}

function phasePendingFromValue(operation: MutationOperation, value: unknown): readonly MutationPendingSurface[] {
  if (operation === "audit") return auditPending(value as AuditReport);
  if (operation === "review" || operation === "deliver") return completionPending(value as CompletionPendingValue);
  return [];
}

/** Purely projects the leading mutation's finality without changing its details. */
export function projectMutationFinality(input: MutationFinalityInput): MutationFinality {
  if (input.kind !== "accepted" || !mutationOperationSchema.safeParse(input.operation).success)
    return { kind: "not-admitted" };
  const pending = collectAcceptedPending(phasePendingFromValue(input.operation, input.value), input);
  return pending.length === 0 ? { kind: "complete" } : { kind: "accepted-pending", pending };
}

export type AcceptedIntent<Value> = Readonly<
  {
    kind: "accepted";
    facts: readonly JournalEntry[];
    head: ContractHead;
    value: Value;
    physical?: ReconcileReport;
  } & AcceptedObligations
>;

export type MutationResult<Value> = Readonly<{
  kind: "accepted";
  operation: MutationOperation;
  facts: readonly JournalEntry[];
  head: ContractHead;
  value: Value;
  lags: ReconcileCompletion["lag"];
  settlementLags: SettlementReport["lags"];
  cleanup: readonly ExecutionCleanup[];
  executionStops: readonly ExecutionStop[];
  recoverySnapshot?: SnapshotId;
  pending: readonly MutationPendingSurface[];
}>;

type Completion<Value, PublicValue> = Readonly<{
  operation: MutationOperation;
  progress?: ExecutionProgress;
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  value: (result: Value) => PublicValue;
  hooks: WorktreeHooks;
}>;

export function completionInput<Value, PublicValue>(
  input: Omit<Completion<Value, PublicValue>, "accepted">,
): Omit<Completion<Value, PublicValue>, "accepted"> {
  return input;
}

function rememberLeading<Value, PublicValue>(input: Completion<Value, PublicValue>, progress: ExecutionProgress): void {
  const { accepted, contractId } = input;
  // An accepted audit may be observational and deliberately contain no new fact.
  progress.recordPublication(contractId, accepted.head, accepted.facts);
  progress.recordResidue(contractId, accepted);
  if (input.progress === undefined) progress.recordVerification(contractId, undefined, accepted);
}

async function reconcileExecution<Value, PublicValue>(
  input: Completion<Value, PublicValue>,
  progress: ExecutionProgress,
): Promise<readonly ReconcileCompletion[]> {
  const contracts = [...new Set([input.contractId, ...progress.snapshot().affected])];
  const reports: ReconcileCompletion[] = [];
  for (const contractId of contracts) {
    try {
      input.scope.signal?.throwIfAborted();
      const report = await completeReconcile({
        scope: input.scope,
        channel: input.channel,
        contractId,
        hooks: input.hooks,
        retryHooks: false,
      });
      reports.push(report);
      progress.recordResidue(contractId, report.settlement);
    } catch (error) {
      progress.recordStop(executionStop(contractId, "reconciliation", error, input.scope.signal));
    }
  }
  return reports;
}

export async function completeMutation<Value, PublicValue>(
  input: Completion<Value, PublicValue>,
): Promise<MutationResult<PublicValue>> {
  const progress = input.progress ?? new ExecutionProgress();
  rememberLeading(input, progress);
  try {
    const reports = await reconcileExecution(input, progress);
    const snapshot = progress.snapshot();
    const effects = [...snapshot.physical.effects, ...reports.flatMap((report) => report.effects)];
    const recoverySnapshot = effects.findLast((effect) => effect.kind === "recovery-snapshot")?.snapshot;
    const publicValue = input.value(input.accepted.value);
    const lags = [...snapshot.physical.lag, ...reports.flatMap((report) => report.lag)];
    const settlementLags = reports.flatMap((report) => report.settlement.lags);
    const obligations = { lags, settlementLags, cleanup: snapshot.cleanup, executionStops: snapshot.stops };
    return {
      kind: "accepted",
      operation: input.operation,
      facts: snapshot.facts,
      head: progress.head(input.contractId) ?? input.accepted.head,
      value: publicValue,
      ...obligations,
      pending: collectAcceptedPending(phasePendingFromValue(input.operation, publicValue), obligations),
      ...(recoverySnapshot === undefined ? {} : { recoverySnapshot }),
    };
  } catch (error) {
    const receipt = receiptFromProgress(input.operation, input.contractId, progress);
    throw receipt === undefined ? error : withExecutionReceipt(error, receipt);
  }
}

export async function completeHolderMutation<Value, PublicValue, Refusal>(
  input: Readonly<{
    completion: Omit<Completion<Value, PublicValue>, "accepted">;
    admission: TaskHolderAdmission<IntentOutcome<Value, Refusal>>;
    requireAccepted: (result: IntentOutcome<Value, Refusal>) => AcceptedIntent<Value>;
  }>,
): Promise<MutationResult<PublicValue>> {
  const accepted = input.requireAccepted(input.admission.result);
  // Fence teardown after confirmed admission is custodial residue. Settlement in
  // completeMutation already reports any still-owed holder publication; do not
  // invent a second owed-holder lag from fence close alone.
  return await completeMutation({ ...input.completion, accepted });
}
