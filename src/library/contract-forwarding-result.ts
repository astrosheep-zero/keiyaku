import { encodeEntry } from "../core/facts/codec.js";
import { changeId, contractHead, contractId, snapshotId, type JournalEntry } from "../core/facts/types.js";
import type { IntegrationConflictMaterialized } from "../protocol/deliver.js";
import type { ReviewValue } from "../protocol/review.js";
import type { ContinuationReport } from "./continuation.js";
import type { DeliveryValue } from "./delivery.js";
import type { MutationResult } from "./mutation.js";
import type { KeiyakuRefusal, KeiyakuRetryReason } from "./refusal.js";
import { reconciliationEffect, reconciliationLag } from "./contract-forwarding-reconciliation-result.js";

export type Review = ReviewValue & Readonly<{ continuation?: ContinuationReport }>;

export type ForwardedMutationReceipt<Value> =
  | Readonly<{ kind: "accepted"; result: MutationResult<Value> }>
  | Readonly<{ kind: "refused"; refusal: KeiyakuRefusal }>
  | Readonly<{ kind: "retry"; reason: KeiyakuRetryReason }>;

export type ForwardedDeliveryReceipt = ForwardedMutationReceipt<DeliveryValue> | IntegrationConflictMaterialized;

export type ForwardedReviewReceipt = ForwardedMutationReceipt<Review>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactResultKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function canonicalHead(value: unknown): boolean {
  if (!nonblank(value)) return false;
  try {
    contractHead(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalSnapshot(value: unknown): boolean {
  if (!nonblank(value)) return false;
  try {
    snapshotId(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalChange(value: unknown): boolean {
  if (!nonblank(value)) return false;
  try {
    changeId(value);
    return true;
  } catch {
    return false;
  }
}

function canonicalContract(value: unknown): boolean {
  if (!nonblank(value)) return false;
  try {
    contractId(value);
    return true;
  } catch {
    return false;
  }
}

function journalFact(value: unknown): boolean {
  try {
    encodeEntry(value as JournalEntry);
    return true;
  } catch {
    return false;
  }
}

function receiptResultKeys(result: Readonly<Record<string, unknown>>): readonly string[] {
  return [
    "effects",
    "facts",
    "head",
    "lags",
    "settlement",
    "value",
    ...(result.cleanup === undefined ? [] : ["cleanup"]),
    ...(result.hookRuns === undefined ? [] : ["hookRuns"]),
    ...(result.leak === undefined ? [] : ["leak"]),
  ];
}

function hookRuns(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((run) => {
      const item = record(run);
      return (
        item !== null &&
        exactResultKeys(item, ["name", "phase"]) &&
        nonblank(item.name) &&
        (item.phase === "create" || item.phase === "destroy")
      );
    })
  );
}

function settlement(value: unknown): boolean {
  const report = record(value);
  if (
    report === null ||
    !exactResultKeys(report, ["actions", "lags"]) ||
    !Array.isArray(report.actions) ||
    !Array.isArray(report.lags)
  )
    return false;
  const actions = report.actions.every((action) => {
    const item = record(action);
    if (item === null || typeof item.kind !== "string") return false;
    if (item.kind === "task")
      return exactResultKeys(item, ["action", "kind", "taskId"]) && item.action === "done" && nonblank(item.taskId);
    return (
      item.kind === "namespace-context" &&
      exactResultKeys(item, ["action", "kind", "path"]) &&
      nonblank(item.path) &&
      (item.action === "installed" || item.action === "kept")
    );
  });
  return (
    actions &&
    report.lags.every((lag) => {
      const item = record(lag);
      return (
        item !== null &&
        item.kind === "settlement-failed" &&
        nonblank(item.diagnostic) &&
        canonicalContract(item.contractId) &&
        ["task-holder", "task", "namespace-context"].includes(item.surface as string) &&
        (item.taskId === undefined || nonblank(item.taskId)) &&
        (item.path === undefined || nonblank(item.path))
      );
    })
  );
}

function completionVerification(value: unknown): boolean {
  const verification = record(value);
  return (
    verification !== null &&
    exactResultKeys(verification, ["mode", "verdict"]) &&
    ["ran", "reused"].includes(verification.mode as string) &&
    ["satisfied", "unsatisfied"].includes(verification.verdict as string)
  );
}

function completionRecord(value: unknown): boolean {
  const completion = record(value);
  if (completion === null || !canonicalSnapshot(completion.integration)) return false;
  const expected = ["integration", ...(completion.verification === undefined ? [] : ["verification"])];
  return (
    exactResultKeys(completion, expected) &&
    (completion.verification === undefined || completionVerification(completion.verification))
  );
}

function workspaceEvidence(value: unknown): boolean {
  const workspace = record(value);
  return (
    workspace !== null &&
    exactResultKeys(workspace, ["shortStat", "staged", "unstaged", "untracked"]) &&
    Array.isArray(workspace.staged) &&
    Array.isArray(workspace.unstaged) &&
    Array.isArray(workspace.untracked) &&
    workspace.staged.every(nonblank) &&
    workspace.unstaged.every(nonblank) &&
    workspace.untracked.every(nonblank)
  );
}

function genericEvidenceRecord(value: unknown): boolean {
  return record(value) !== null;
}

const completionEvidenceVariants: Readonly<Record<string, (value: unknown) => boolean>> = {
  completion: completionRecord,
  verificationSummary: nonblank,
  workspace: workspaceEvidence,
  verification: genericEvidenceRecord,
  verificationReuse: genericEvidenceRecord,
  placement: genericEvidenceRecord,
  cleanup: genericEvidenceRecord,
  leak: genericEvidenceRecord,
  continuation: genericEvidenceRecord,
};

function completionEvidence(value: unknown, allowed: readonly string[]): boolean {
  const evidence = record(value);
  if (evidence === null) return false;
  if (
    !exactResultKeys(
      evidence,
      allowed.filter((key) => evidence[key] !== undefined),
    )
  )
    return false;
  return allowed.every((field) => {
    const decoder = completionEvidenceVariants[field];
    return evidence[field] === undefined || decoder === undefined || decoder(evidence[field]);
  });
}

function deliveryValue(value: unknown): boolean {
  const delivery = record(value);
  if (delivery === null) return false;
  const allowed = [
    "cleanup",
    "completion",
    "continuation",
    "integration",
    "leak",
    "method",
    "placement",
    "policy",
    "tenderSnapshot",
    "verification",
    "verificationReuse",
    "verificationSummary",
  ];
  const integration = record(delivery.integration);
  const policy = record(delivery.policy);
  return (
    completionEvidence(delivery, allowed) &&
    canonicalSnapshot(delivery.tenderSnapshot) &&
    integration !== null &&
    exactResultKeys(integration, ["changeId", "predecessor", "snapshot"]) &&
    canonicalChange(integration.changeId) &&
    canonicalSnapshot(integration.predecessor) &&
    canonicalSnapshot(integration.snapshot) &&
    delivery.method === "squash" &&
    policy !== null &&
    exactResultKeys(policy, ["requireBranchesToBeUpToDate"]) &&
    typeof policy.requireBranchesToBeUpToDate === "boolean"
  );
}

function reviewValue(value: unknown): boolean {
  return completionEvidence(value, [
    "cleanup",
    "completion",
    "continuation",
    "leak",
    "placement",
    "verification",
    "verificationReuse",
    "verificationSummary",
    "workspace",
  ]);
}

function acceptedResult(value: unknown, valueDecoder: (value: unknown) => boolean): boolean {
  const result = record(value);
  return (
    result !== null &&
    exactResultKeys(result, receiptResultKeys(result)) &&
    Array.isArray(result.facts) &&
    result.facts.every(journalFact) &&
    canonicalHead(result.head) &&
    valueDecoder(result.value) &&
    Array.isArray(result.effects) &&
    result.effects.every(reconciliationEffect) &&
    Array.isArray(result.lags) &&
    result.lags.every(reconciliationLag) &&
    settlement(result.settlement) &&
    (result.cleanup === undefined || record(result.cleanup) !== null) &&
    (result.hookRuns === undefined || hookRuns(result.hookRuns)) &&
    (result.leak === undefined || record(result.leak) !== null)
  );
}

function isForwardedRefusal(receipt: Readonly<Record<string, unknown>>): boolean {
  const refusal = record(receipt.refusal);
  return exactResultKeys(receipt, ["kind", "refusal"]) && refusal !== null && nonblank(refusal.kind);
}

function isForwardedRetry(receipt: Readonly<Record<string, unknown>>): boolean {
  return exactResultKeys(receipt, ["kind", "reason"]) && typeof receipt.reason === "string";
}

export function isForwardedDeliveryReceipt(value: unknown): value is ForwardedDeliveryReceipt {
  const receipt = record(value);
  if (receipt === null || typeof receipt.kind !== "string") return false;
  if (receipt.kind === "accepted")
    return exactResultKeys(receipt, ["kind", "result"]) && acceptedResult(receipt.result, deliveryValue);
  if (receipt.kind === "refused") return isForwardedRefusal(receipt);
  if (receipt.kind === "retry") return isForwardedRetry(receipt);
  return (
    receipt.kind === "integration-conflict-materialized" &&
    exactResultKeys(receipt, ["conflictPaths", "kind", "targetHead", "workspace"]) &&
    canonicalSnapshot(receipt.targetHead) &&
    Array.isArray(receipt.conflictPaths) &&
    receipt.conflictPaths.every(nonblank) &&
    record(receipt.workspace)?.kind === "worktree" &&
    nonblank(record(receipt.workspace)?.path)
  );
}

export function isForwardedReviewReceipt(value: unknown): value is ForwardedReviewReceipt {
  const receipt = record(value);
  if (receipt === null || typeof receipt.kind !== "string") return false;
  if (receipt.kind === "accepted")
    return exactResultKeys(receipt, ["kind", "result"]) && acceptedResult(receipt.result, reviewValue);
  if (receipt.kind === "refused") return isForwardedRefusal(receipt);
  return receipt.kind === "retry" && isForwardedRetry(receipt);
}
