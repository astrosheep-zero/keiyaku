import { changeId, contractId, entryUlid, snapshotId, type ContractId, type SnapshotId } from "../core/facts/types.js";
import { decodeDeliverData } from "../core/facts/codec.js";
import { decodeAbandonRefusal } from "../core/verbs/abandon.js";
import { decodeAmendRefusal } from "../core/verbs/amend.js";
import { decodeArcRefusal } from "../core/verbs/arc.js";
import { decodeAttestationRefusal, type AttestationRefusal } from "../core/verbs/attestation.js";
import { decodeBindRefusal } from "../core/verbs/bind.js";
import { decodeDeliverRefusal } from "../core/verbs/deliver.js";
import { decodePlacementRefusal } from "../core/verbs/placement.js";
import {
  decodeAuditTargetAnswer,
  decodeCheckoutNotFollowableRefusal,
  decodeDirtyWorkspaceRefusal,
  decodeHookFailure,
  decodeIntegrationPreparationRefusal,
  decodePublicationFailed,
  decodeUnmergedPathsRefusal,
  decodeWorktreeLeak,
  decodeWorktreeMissingRefusal,
  decodeWorktreeWorkspace,
  decodeWorkspaceDirtyDelta,
} from "../git/result-codec.js";
import { decodeVerificationDeclarationRefusal } from "../verification/declaration.js";
import type { VerificationDeclarationRefusal } from "../verification/declaration.js";
import type { AuditReport } from "./audit.js";
import { decodeForkSourceMovedRefusal, decodeTargetInputRefusal } from "./bind.js";
import type { CandidateCompletion, CompletionEvidence } from "./completion.js";
import type { IntegrationConflictMaterialized } from "./deliver.js";
import type { CurrentVerifiedAttestation, VerificationCleanupFailure, VerificationRuntimeStop } from "./intent.js";
import type {
  DeliverConflictRefusal,
  DeliveryPreparationRefusal,
  IntentRefusal,
  MergeStatePresentRefusal,
  PlacementStop,
  VerificationStop,
} from "./operations.js";
import type { ReviewValue } from "./review.js";
import type { ProtocolTerminal } from "./run.js";

function fail(): never {
  throw new Error("malformed protocol result");
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail();
  for (const key of required) if (!(key in object)) fail();
  return object;
}

function nonblank(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") fail();
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) fail();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function strings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) fail();
  return value.map(nonblank);
}

function decodeContractId(value: unknown): ContractId {
  try {
    return contractId(nonblank(value));
  } catch {
    fail();
  }
}

function decodeSnapshotId(value: unknown): SnapshotId {
  try {
    return snapshotId(nonblank(value));
  } catch {
    fail();
  }
}

function first<const Decoders extends readonly ((value: unknown) => unknown)[]>(
  value: unknown,
  decoders: Decoders,
): ReturnType<Decoders[number]> {
  for (const decode of decoders) {
    try {
      return decode(value) as ReturnType<Decoders[number]>;
    } catch {
      continue;
    }
  }
  fail();
}

export function decodeProtocolTerminal(value: unknown): ProtocolTerminal {
  const object = record(value, ["kind"], ["diagnostic"]);
  if (object.kind === "exhausted" || object.kind === "collision") {
    if ("diagnostic" in object) fail();
    return { kind: object.kind };
  }
  return decodePublicationFailed(value);
}

export function decodeMergeStatePresentRefusal(value: unknown): MergeStatePresentRefusal {
  const object = record(value, ["kind", "contractId", "workspace"]);
  if (object.kind !== "merge-state-present") fail();
  return {
    kind: "merge-state-present",
    contractId: decodeContractId(object.contractId),
    workspace: decodeWorktreeWorkspace(object.workspace),
  };
}

export function decodeDeliverConflictRefusal(value: unknown): DeliverConflictRefusal {
  const object = record(value, ["kind", "contractId", "reason", "targetHead", "conflictPaths", "recovery"]);
  if (object.kind !== "integration-failed" || object.reason !== "conflict") fail();
  const recovery = record(object.recovery, ["materialize", "continue"]);
  if (recovery.materialize !== "deliver --materialize-conflict --include-dirty") fail();
  if (recovery.continue !== "deliver --include-dirty") fail();
  return {
    kind: "integration-failed",
    contractId: decodeContractId(object.contractId),
    reason: "conflict",
    targetHead: decodeSnapshotId(object.targetHead),
    conflictPaths: strings(object.conflictPaths),
    recovery: {
      materialize: "deliver --materialize-conflict --include-dirty",
      continue: "deliver --include-dirty",
    },
  };
}

function decodeTargetMissingRefusal(value: unknown): Readonly<{ kind: "target-missing"; contractId: ContractId }> {
  const object = record(value, ["kind", "contractId"]);
  if (object.kind !== "target-missing") fail();
  return { kind: "target-missing", contractId: decodeContractId(object.contractId) };
}

export function decodeDeliveryPreparationRefusal(value: unknown): DeliveryPreparationRefusal {
  return first(value, [
    decodeTargetMissingRefusal,
    decodeWorktreeMissingRefusal,
    decodeDirtyWorkspaceRefusal,
    decodeUnmergedPathsRefusal,
    decodeIntegrationPreparationRefusal,
    decodeMergeStatePresentRefusal,
    decodeCheckoutNotFollowableRefusal,
  ]);
}

export function decodeIntentRefusal(value: unknown): IntentRefusal {
  return first(value, [
    decodeAbandonRefusal,
    decodeAmendRefusal,
    decodeArcRefusal,
    decodeBindRefusal,
    decodeForkSourceMovedRefusal,
    decodeDeliverRefusal,
    decodeDeliveryPreparationRefusal,
    decodeDeliverConflictRefusal,
    decodePlacementRefusal,
    decodeAttestationRefusal,
    decodeTargetInputRefusal,
    decodeVerificationDeclarationRefusal,
  ]);
}

export function decodeVerificationRuntimeStop(value: unknown): VerificationRuntimeStop {
  const object = record(value, ["failure"], ["diagnostic", "command", "detail"]);
  if (object.failure === "unknown-exit" || object.failure === "cancelled") {
    if ("diagnostic" in object || "command" in object || "detail" in object) fail();
    return { failure: object.failure };
  }
  if (object.failure === "candidate-unavailable" || object.failure === "spawn-error") {
    if ("command" in object || "detail" in object) fail();
    return { failure: object.failure, diagnostic: nonblank(object.diagnostic) };
  }
  if (object.failure !== "environment-failure") fail();
  if ("command" in object || "detail" in object) {
    if ("diagnostic" in object) fail();
    return {
      failure: "environment-failure",
      command: integer(object.command),
      detail: decodeHookFailure(object.detail),
    };
  }
  return { failure: "environment-failure", diagnostic: nonblank(object.diagnostic) };
}

function decodeVerificationStepRefusal(
  value: unknown,
): Extract<VerificationStop, { refusal: AttestationRefusal | VerificationDeclarationRefusal }> {
  const object = record(value, ["refusal"]);
  return {
    refusal: first(object.refusal, [decodeAttestationRefusal, decodeVerificationDeclarationRefusal]),
  };
}

function decodeVerificationStepRetry(value: unknown): Extract<VerificationStop, { retry: ProtocolTerminal }> {
  const object = record(value, ["retry"]);
  return { retry: decodeProtocolTerminal(object.retry) };
}

export function decodeVerificationStop(value: unknown): VerificationStop {
  return first(value, [decodeVerificationStepRefusal, decodeVerificationStepRetry, decodeVerificationRuntimeStop]);
}

export function decodeVerificationReuse(value: unknown): CurrentVerifiedAttestation {
  const object = record(value, ["entry", "verdict"], ["summary"]);
  if (object.verdict !== "satisfied" && object.verdict !== "unsatisfied") fail();
  let entry;
  try {
    entry = entryUlid(nonblank(object.entry));
  } catch {
    fail();
  }
  return {
    entry,
    verdict: object.verdict,
    ...(object.summary === undefined ? {} : { summary: typeof object.summary === "string" ? object.summary : fail() }),
  };
}

function decodePlacementStepRefusal(value: unknown) {
  return first(value, [
    decodePlacementRefusal,
    decodeCheckoutNotFollowableRefusal,
    decodeIntegrationPreparationRefusal,
    decodeTargetMissingRefusal,
  ]);
}

function decodePlacementRefusalStop(value: unknown): Extract<PlacementStop, { refusal: unknown }> {
  const object = record(value, ["refusal"]);
  return { refusal: decodePlacementStepRefusal(object.refusal) };
}

function decodePlacementRetryStop(value: unknown): Extract<PlacementStop, { retry: ProtocolTerminal }> {
  const object = record(value, ["retry"]);
  return { retry: decodeProtocolTerminal(object.retry) };
}

function decodeTargetPlacementFailedStop(
  value: unknown,
): Extract<PlacementStop, { failure: "target-placement-failed" }> {
  const object = record(value, ["failure", "diagnostic"]);
  if (object.failure !== "target-placement-failed") fail();
  return { failure: "target-placement-failed", diagnostic: nonblank(object.diagnostic) };
}

function decodeTargetMovedWithAttemptsStop(
  value: unknown,
): Extract<PlacementStop, { failure: "target-moved"; integratedAt: SnapshotId }> {
  const object = record(value, [
    "failure",
    "contractId",
    "target",
    "integratedAt",
    "observed",
    "attempts",
    "observedTreeEqualsCandidate",
  ]);
  if (object.failure !== "target-moved") fail();
  return {
    failure: "target-moved",
    contractId: decodeContractId(object.contractId),
    target: nonblank(object.target),
    integratedAt: decodeSnapshotId(object.integratedAt),
    observed: object.observed === null ? null : decodeSnapshotId(object.observed),
    attempts: integer(object.attempts),
    observedTreeEqualsCandidate: boolean(object.observedTreeEqualsCandidate),
  };
}

function decodeTargetMovedExpectedStop(
  value: unknown,
): Extract<PlacementStop, { failure: "target-moved"; expected: SnapshotId }> {
  const object = record(value, [
    "failure",
    "contractId",
    "target",
    "expected",
    "observed",
    "observedTreeEqualsCandidate",
  ]);
  if (object.failure !== "target-moved") fail();
  return {
    failure: "target-moved",
    contractId: decodeContractId(object.contractId),
    target: nonblank(object.target),
    expected: decodeSnapshotId(object.expected),
    observed: object.observed === null ? null : decodeSnapshotId(object.observed),
    observedTreeEqualsCandidate: boolean(object.observedTreeEqualsCandidate),
  };
}

export function decodePlacementStop(value: unknown): PlacementStop {
  return first(value, [
    decodePlacementRefusalStop,
    decodePlacementRetryStop,
    decodeTargetPlacementFailedStop,
    decodeTargetMovedWithAttemptsStop,
    decodeTargetMovedExpectedStop,
  ]);
}

export function decodeVerificationCleanupFailure(value: unknown): VerificationCleanupFailure {
  const object = record(value, ["phase", "command", "detail"]);
  if (object.phase !== "destroy") fail();
  return { phase: "destroy", command: integer(object.command), detail: decodeHookFailure(object.detail) };
}

export function decodeCandidateCompletion(value: unknown): CandidateCompletion {
  const object = record(value, ["integration"], ["verification"]);
  const completion: CandidateCompletion = {
    integration: decodeSnapshotId(object.integration),
    ...(object.verification === undefined
      ? {}
      : {
          verification: (() => {
            const verification = record(object.verification, ["mode", "verdict"]);
            if (verification.mode !== "ran" && verification.mode !== "reused") fail();
            if (verification.verdict !== "satisfied" && verification.verdict !== "unsatisfied") fail();
            return { mode: verification.mode, verdict: verification.verdict };
          })(),
        }),
  };
  return completion;
}

export function decodeCompletionEvidence(value: unknown): CompletionEvidence {
  const object = record(
    value,
    [],
    ["completion", "verification", "verificationReuse", "verificationSummary", "placement", "cleanup", "leak"],
  );
  return {
    ...(object.completion === undefined ? {} : { completion: decodeCandidateCompletion(object.completion) }),
    ...(object.verification === undefined ? {} : { verification: decodeVerificationStop(object.verification) }),
    ...(object.verificationReuse === undefined
      ? {}
      : { verificationReuse: decodeVerificationReuse(object.verificationReuse) }),
    ...(object.verificationSummary === undefined ? {} : { verificationSummary: nonblank(object.verificationSummary) }),
    ...(object.placement === undefined ? {} : { placement: decodePlacementStop(object.placement) }),
    ...(object.cleanup === undefined ? {} : { cleanup: decodeVerificationCleanupFailure(object.cleanup) }),
    ...(object.leak === undefined ? {} : { leak: decodeWorktreeLeak(object.leak) }),
  };
}

export function decodeMaterializedConflict(value: unknown): IntegrationConflictMaterialized {
  const object = record(value, ["kind", "targetHead", "conflictPaths", "workspace"]);
  if (object.kind !== "integration-conflict-materialized") fail();
  return {
    kind: "integration-conflict-materialized",
    targetHead: decodeSnapshotId(object.targetHead),
    conflictPaths: strings(object.conflictPaths),
    workspace: decodeWorktreeWorkspace(object.workspace),
  };
}

function decodeAuditReadyCandidate(value: unknown): Extract<AuditReport["candidate"], { kind: "ready" }> {
  const object = record(value, ["kind", "workspace", "identity", "scope"], ["diff"]);
  if (object.kind !== "ready") fail();
  const scope = record(object.scope, ["filesChanged", "insertions", "deletions"], ["paths"]);
  return {
    kind: "ready",
    workspace: decodeWorktreeWorkspace(object.workspace),
    identity: decodeDeliverData(object.identity),
    scope: {
      filesChanged: integer(scope.filesChanged),
      insertions: integer(scope.insertions),
      deletions: integer(scope.deletions),
      ...(scope.paths === undefined
        ? {}
        : {
            paths: Array.isArray(scope.paths)
              ? scope.paths.map((path) => (typeof path === "string" ? path : fail()))
              : fail(),
          }),
    },
    ...(object.diff === undefined ? {} : { diff: typeof object.diff === "string" ? object.diff : fail() }),
  };
}

function decodeAuditBlockedCandidate(value: unknown): Extract<AuditReport["candidate"], { kind: "blocked" }> {
  const object = record(value, ["kind", "refusal"]);
  if (object.kind !== "blocked") fail();
  return { kind: "blocked", refusal: decodeDeliveryPreparationRefusal(object.refusal) };
}

function decodeAuditVerification(value: unknown): AuditReport["verification"] {
  return first(value, [
    (input): Extract<AuditReport["verification"], { kind: "not-run" }> => {
      const object = record(input, ["kind"]);
      if (object.kind !== "not-run") fail();
      return { kind: "not-run" };
    },
    (input): Extract<AuditReport["verification"], { kind: "stopped" }> => {
      const object = record(input, ["kind", "stop"]);
      if (object.kind !== "stopped") fail();
      return { kind: "stopped", stop: decodeVerificationStop(object.stop) };
    },
    (input): Extract<AuditReport["verification"], { kind: "satisfied" | "unsatisfied" }> => {
      const object = record(input, ["kind", "passed", "total"], ["summary"]);
      if (object.kind !== "satisfied" && object.kind !== "unsatisfied") fail();
      return {
        kind: object.kind,
        passed: typeof object.passed === "number" ? object.passed : fail(),
        total: typeof object.total === "number" ? object.total : fail(),
        ...(object.summary === undefined
          ? {}
          : { summary: typeof object.summary === "string" ? object.summary : fail() }),
      };
    },
  ]);
}

function decodeNotObservedAuditTarget(value: unknown): Extract<AuditReport["target"], { kind: "not-observed" }> {
  const object = record(value, ["kind"]);
  if (object.kind !== "not-observed") fail();
  return { kind: "not-observed" };
}

function decodeAuditTarget(value: unknown): AuditReport["target"] {
  return first(value, [decodeNotObservedAuditTarget, decodeAuditTargetAnswer]);
}

export function decodeAuditReport(value: unknown): AuditReport {
  const object = record(value, ["candidate", "verification", "target"], ["delivery"]);
  return {
    candidate: first(object.candidate, [decodeAuditBlockedCandidate, decodeAuditReadyCandidate]),
    verification: decodeAuditVerification(object.verification),
    target: decodeAuditTarget(object.target),
    ...(object.delivery === undefined
      ? {}
      : {
          delivery: (() => {
            const delivery = record(object.delivery, ["changeId", "relation"]);
            if (delivery.relation !== "identical" && delivery.relation !== "differs") fail();
            try {
              return { changeId: changeId(nonblank(delivery.changeId)), relation: delivery.relation };
            } catch {
              fail();
            }
          })(),
        }),
  };
}

export function decodeReviewValue(value: unknown): ReviewValue {
  const object = record(
    value,
    [],
    [
      "completion",
      "verification",
      "verificationReuse",
      "verificationSummary",
      "placement",
      "cleanup",
      "leak",
      "workspace",
    ],
  );
  const evidence = decodeCompletionEvidence({
    ...(object.completion === undefined ? {} : { completion: object.completion }),
    ...(object.verification === undefined ? {} : { verification: object.verification }),
    ...(object.verificationReuse === undefined ? {} : { verificationReuse: object.verificationReuse }),
    ...(object.verificationSummary === undefined ? {} : { verificationSummary: object.verificationSummary }),
    ...(object.placement === undefined ? {} : { placement: object.placement }),
    ...(object.cleanup === undefined ? {} : { cleanup: object.cleanup }),
    ...(object.leak === undefined ? {} : { leak: object.leak }),
  });
  return {
    ...evidence,
    ...(object.workspace === undefined ? {} : { workspace: decodeWorkspaceDirtyDelta(object.workspace) }),
  };
}
