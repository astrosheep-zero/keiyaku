import { decodeJournalEntry } from "../core/facts/codec.js";
import {
  contractHead,
  snapshotId,
  type ContractHead,
  type ContractId,
  type JournalEntry,
  type SnapshotId,
} from "../core/facts/types.js";
import { decodePrivateStateSeatCloseLag, decodeWorktreeLeak } from "../git/result-codec.js";
import { concatenatePrivateStateSeatClose, type PrivateStateSeatCloseLag } from "../git/private-state-seat.js";
import type { GitDecodeChannel } from "../git/read-observation.js";
import type { ReconcileReport } from "../protocol/reconcile.js";
import type { RepositoryScope } from "../protocol/operations.js";
import type { IntentOutcome } from "../protocol/operations.js";
import type { AcceptedObligations } from "../protocol/outcome.js";
import { decodeVerificationCleanupFailure } from "../protocol/result-codec.js";
import { decodeSettlementLag } from "../settlement/result-codec.js";
import type { SettlementReport } from "../settlement/settle.js";
import type { TaskHolderAdmission } from "../settlement/holder.js";
import type { WorktreeHooks } from "./configuration.js";
import { completeReconcile, decodeReconciliationLag, type ReconcileCompletion } from "./reconcile.js";
import type { AuditReport } from "../protocol/audit.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { ContinuationReport } from "./continuation.js";
import type { KeiyakuRefused, KeiyakuRetry } from "./refusal.js";
import { ownerSchema } from "./result-codec.js";
import { z } from "zod";

export type MutationFinalitySurface =
  | "verification"
  | "placement"
  | "continuation"
  | "reconciliation"
  | "settlement"
  | "cleanup";

export type MutationFinality =
  | Readonly<{ kind: "complete" }>
  | Readonly<{
      kind: "accepted-pending";
      pending: readonly Readonly<{ surface: MutationFinalitySurface; required: boolean }>[];
    }>
  | Readonly<{ kind: "not-admitted" }>;

type AcceptedFinalityInput = Readonly<{
  kind: "accepted";
  lags: MutationResult<unknown>["lags"];
  settlementLags: MutationResult<unknown>["settlementLags"];
  value?: unknown;
  cleanup?: AcceptedObligations["cleanup"];
  leak?: AcceptedObligations["leak"];
  seatClose?: AcceptedObligations["seatClose"];
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
    object.surface !== "cleanup"
  )
    throw new Error("malformed pending surface");
  if (typeof object.required !== "boolean") throw new Error("malformed pending surface");
  return { surface: object.surface, required: object.required };
}

export const mutationPendingSurfaceSchema = ownerSchema(
  decodeMutationPendingSurface,
  "expected pending surface",
) satisfies z.ZodType<MutationPendingSurface>;

export const mutationResultSchema = <Value>(value: z.ZodType<Value>): z.ZodType<MutationResult<Value>> =>
  ownerSchema((input): MutationResult<Value> => {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("malformed mutation result");
    const object = input as Record<string, unknown>;
    if (object.kind !== "accepted") throw new Error("malformed mutation result");
    if (typeof object.head !== "string") throw new Error("malformed mutation result");
    const parsedValue = value.safeParse(object.value);
    if (!parsedValue.success) throw new Error("malformed mutation result");
    if (
      !Array.isArray(object.facts) ||
      !Array.isArray(object.lags) ||
      !Array.isArray(object.settlementLags) ||
      !Array.isArray(object.pending)
    )
      throw new Error("malformed mutation result");
    const allowed = new Set([
      "kind",
      "facts",
      "head",
      "value",
      "lags",
      "settlementLags",
      "pending",
      "recoverySnapshot",
      "cleanup",
      "leak",
      "seatClose",
    ]);
    for (const key of Object.keys(object)) if (!allowed.has(key)) throw new Error("malformed mutation result");
    return {
      kind: "accepted",
      facts: object.facts.map(decodeJournalEntry),
      head: contractHead(object.head),
      value: parsedValue.data,
      lags: object.lags.map(decodeReconciliationLag),
      settlementLags: object.settlementLags.map(decodeSettlementLag),
      pending: object.pending.map(decodeMutationPendingSurface),
      ...(object.recoverySnapshot === undefined
        ? {}
        : { recoverySnapshot: snapshotId(String(object.recoverySnapshot)) }),
      ...(object.cleanup === undefined ? {} : { cleanup: decodeVerificationCleanupFailure(object.cleanup) }),
      ...(object.leak === undefined ? {} : { leak: decodeWorktreeLeak(object.leak) }),
      ...(object.seatClose === undefined
        ? {}
        : {
            seatClose: Array.isArray(object.seatClose)
              ? object.seatClose.map(decodePrivateStateSeatCloseLag)
              : (() => {
                  throw new Error("malformed mutation result");
                })(),
          }),
    };
  }, "expected mutation result");

type ObligationPendingInput = Readonly<{
  lags: MutationResult<unknown>["lags"];
  settlementLags: MutationResult<unknown>["settlementLags"];
  cleanup?: AcceptedObligations["cleanup"];
  leak?: AcceptedObligations["leak"];
  seatClose?: AcceptedObligations["seatClose"];
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
  if (input.cleanup !== undefined || input.leak !== undefined || (input.seatClose?.length ?? 0) > 0) {
    pending.push(pendingSurface("cleanup", false));
  }
  return pending;
}

export function collectAcceptedPending(
  valuePending: readonly MutationPendingSurface[],
  obligations: ObligationPendingInput,
): readonly MutationPendingSurface[] {
  return [...valuePending, ...obligationPending(obligations)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function phasePendingFromValue(value: unknown): readonly MutationPendingSurface[] {
  if (!isRecord(value)) return [];
  if ("candidate" in value && "verification" in value && "target" in value) {
    return auditPending(value as AuditReport);
  }
  if ("verification" in value || "placement" in value || "continuation" in value) {
    return completionPending(value as CompletionPendingValue);
  }
  return [];
}

function obligationSurfacesFromAccepted(input: AcceptedFinalityInput): ObligationPendingInput {
  return {
    lags: input.lags,
    settlementLags: input.settlementLags,
    ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup }),
    ...(input.leak === undefined ? {} : { leak: input.leak }),
    ...(input.seatClose === undefined || input.seatClose.length === 0 ? {} : { seatClose: input.seatClose }),
  };
}

/** Purely projects the leading mutation's finality without changing its details. */
export function projectMutationFinality(input: MutationFinalityInput): MutationFinality {
  if (input.kind !== "accepted") return { kind: "not-admitted" };
  const pending = collectAcceptedPending(phasePendingFromValue(input.value), obligationSurfacesFromAccepted(input));
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

export type MutationResult<Value> = Readonly<
  {
    kind: "accepted";
    facts: readonly JournalEntry[];
    head: ContractHead;
    value: Value;
    lags: ReconcileCompletion["lag"];
    settlementLags: SettlementReport["lags"];
    recoverySnapshot?: SnapshotId;
    pending: readonly MutationPendingSurface[];
  } & AcceptedObligations
>;

type Completion<Value, PublicValue> = Readonly<{
  scope: RepositoryScope;
  channel: GitDecodeChannel;
  contractId: ContractId;
  accepted: AcceptedIntent<Value>;
  value: (result: Value) => PublicValue;
  valuePending?: (value: PublicValue) => readonly MutationPendingSurface[];
  hooks: WorktreeHooks;
}>;

export function completionInput<Value, PublicValue>(
  input: Readonly<{
    scope: RepositoryScope;
    channel: GitDecodeChannel;
    contractId: ContractId;
    value: (result: Value) => PublicValue;
    hooks: WorktreeHooks;
    valuePending?: (value: PublicValue) => readonly MutationPendingSurface[];
  }>,
): Omit<Completion<Value, PublicValue>, "accepted"> {
  return { ...input, valuePending: input.valuePending ?? noValuePending };
}

function concatenateSettlementSeatClose(
  current: readonly PrivateStateSeatCloseLag[] | undefined,
  reports: readonly ReconcileCompletion[],
): readonly PrivateStateSeatCloseLag[] | undefined {
  return reports.reduce<readonly PrivateStateSeatCloseLag[] | undefined>(
    (seatClose, report) => concatenatePrivateStateSeatClose(seatClose, report.settlement.seatClose),
    current,
  );
}

export async function completeMutation<Value, PublicValue>(
  input: Completion<Value, PublicValue>,
): Promise<MutationResult<PublicValue>> {
  const { scope, channel, contractId, accepted, value, hooks } = input;
  const valuePending = input.valuePending ?? noValuePending;
  const contracts = [...new Set([contractId, ...accepted.facts.map((fact) => fact.contract)])];
  const reports: ReconcileCompletion[] = [];
  for (const affected of contracts) {
    reports.push(await completeReconcile({ scope, channel, contractId: affected, hooks, retryHooks: false }));
  }
  const seatClose = concatenateSettlementSeatClose(accepted.seatClose, reports);
  const obligations: AcceptedObligations = {
    ...(accepted.cleanup === undefined ? {} : { cleanup: accepted.cleanup }),
    ...(accepted.leak === undefined ? {} : { leak: accepted.leak }),
    ...(seatClose === undefined || seatClose.length === 0 ? {} : { seatClose }),
  };
  const effects = [...(accepted.physical?.effects ?? []), ...reports.flatMap((report) => report.effects)];
  const recoverySnapshot = effects.findLast((effect) => effect.kind === "recovery-snapshot")?.snapshot;
  const publicValue = value(accepted.value);
  const lags = [...(accepted.physical?.lag ?? []), ...reports.flatMap((report) => report.lag)];
  const settlementLags = reports.flatMap((report) => report.settlement.lags);
  return {
    kind: "accepted",
    facts: accepted.facts,
    head: accepted.head,
    value: publicValue,
    lags,
    settlementLags,
    pending: collectAcceptedPending(valuePending(publicValue), {
      lags,
      settlementLags,
      ...obligations,
    }),
    ...(recoverySnapshot === undefined ? {} : { recoverySnapshot }),
    ...obligations,
  };
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
