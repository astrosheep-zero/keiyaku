import { contractId, snapshotId, type ContractId, type SnapshotId } from "../core/facts/types.js";
import type { PublicationFailed } from "./admission.js";
import type { HookFailure, WorktreeHookLag } from "./hooks.js";
import { mintSnapshotId } from "./identity.js";
import type { IntegrationPreparationRefusal } from "./integration.js";
import type { PrivateStateSeatCloseLag } from "./private-state-seat.js";
import type { ReconcileFailure, ReconcileLag } from "./reconcile.js";
import type { WorktreeLeak } from "./scratch.js";
import type { AuditTargetAnswer, CheckoutNotFollowableRefusal, TargetCheckoutLag } from "./target-placement.js";
import type { UnsealedBytes } from "./terminal-seal.js";
import type { DirtyWorkspaceRefusal, WorkspaceDirtyDelta, WorktreeMissingRefusal } from "./tender.js";

function fail(message = "malformed git result"): never {
  throw new Error(message);
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

function nonnegativeInteger(value: unknown): number {
  const n = integer(value);
  if (n < 0) fail();
  return n;
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

function decodeGitSnapshotId(value: unknown): SnapshotId {
  try {
    return mintSnapshotId(nonblank(value));
  } catch {
    fail();
  }
}

export function decodeHookFailure(value: unknown): HookFailure {
  const object = record(value, ["kind"], ["code", "stdout", "stderr", "truncated", "diagnostic"]);
  if (object.kind === "timeout" || object.kind === "unknown-exit") {
    if ("code" in object || "stdout" in object || "stderr" in object || "truncated" in object || "diagnostic" in object)
      fail();
    return { kind: object.kind };
  }
  if (object.kind === "spawn-error") {
    if ("code" in object || "stdout" in object || "stderr" in object || "truncated" in object) fail();
    return { kind: "spawn-error", diagnostic: nonblank(object.diagnostic) };
  }
  if (object.kind !== "exit") fail();
  if ("diagnostic" in object) fail();
  return {
    kind: "exit",
    code: integer(object.code),
    stdout: typeof object.stdout === "string" ? object.stdout : fail(),
    stderr: typeof object.stderr === "string" ? object.stderr : fail(),
    truncated: boolean(object.truncated),
  };
}

export function decodeWorktreeLeak(value: unknown): WorktreeLeak {
  const object = record(value, ["path", "diagnostic"]);
  if (typeof object.path !== "string" || typeof object.diagnostic !== "string") fail();
  return { path: object.path, diagnostic: object.diagnostic };
}

export function decodePrivateStateSeatCloseLag(value: unknown): PrivateStateSeatCloseLag {
  const object = record(value, ["kind", "diagnostic"]);
  if (object.kind !== "private-state-seat-close-failed") fail();
  return { kind: "private-state-seat-close-failed", diagnostic: nonblank(object.diagnostic) };
}

export function decodePublicationFailed(value: unknown): PublicationFailed {
  const object = record(value, ["kind", "diagnostic"]);
  if (object.kind !== "publication-failed") fail();
  if (typeof object.diagnostic !== "string") fail();
  return { kind: "publication-failed", diagnostic: object.diagnostic };
}

export function decodeWorktreeWorkspace(value: unknown): Readonly<{ kind: "worktree"; path: string }> {
  const object = record(value, ["kind", "path"]);
  if (object.kind !== "worktree") fail();
  return { kind: "worktree", path: nonblank(object.path) };
}

export function decodeWorkspaceDirtyDelta(value: unknown): WorkspaceDirtyDelta {
  const object = record(value, ["staged", "unstaged", "untracked", "shortStat"]);
  const shortStat = record(object.shortStat, ["filesChanged", "insertions", "deletions"]);
  return {
    staged: Array.isArray(object.staged)
      ? object.staged.map((path) => (typeof path === "string" ? path : fail()))
      : fail(),
    unstaged: Array.isArray(object.unstaged)
      ? object.unstaged.map((path) => (typeof path === "string" ? path : fail()))
      : fail(),
    untracked: Array.isArray(object.untracked)
      ? object.untracked.map((path) => (typeof path === "string" ? path : fail()))
      : fail(),
    shortStat: {
      filesChanged: integer(shortStat.filesChanged),
      insertions: integer(shortStat.insertions),
      deletions: integer(shortStat.deletions),
    },
  };
}

export function decodeWorktreeMissingRefusal(value: unknown): WorktreeMissingRefusal {
  const object = record(value, ["kind", "contractId"]);
  if (object.kind !== "worktree-missing") fail();
  return { kind: "worktree-missing", contractId: decodeContractId(object.contractId) };
}

export function decodeUnmergedPathsRefusal(
  value: unknown,
): Readonly<{ kind: "unmerged-paths"; contractId: ContractId; paths: readonly string[] }> {
  const object = record(value, ["kind", "contractId", "paths"]);
  if (object.kind !== "unmerged-paths") fail();
  return { kind: "unmerged-paths", contractId: decodeContractId(object.contractId), paths: strings(object.paths) };
}

export function decodeDirtyWorkspaceRefusal(value: unknown): DirtyWorkspaceRefusal {
  const object = record(value, ["kind", "contractId", "staged", "unstaged", "untracked", "submodules", "shortStat"]);
  if (object.kind !== "dirty-workspace") fail();
  const shortStat = record(object.shortStat, ["filesChanged", "insertions", "deletions"]);
  return {
    kind: "dirty-workspace",
    contractId: decodeContractId(object.contractId),
    staged: strings(object.staged),
    unstaged: strings(object.unstaged),
    untracked: strings(object.untracked),
    submodules: strings(object.submodules),
    shortStat: {
      filesChanged: nonnegativeInteger(shortStat.filesChanged),
      insertions: nonnegativeInteger(shortStat.insertions),
      deletions: nonnegativeInteger(shortStat.deletions),
    },
  };
}

export function decodeIntegrationPreparationRefusal(value: unknown): IntegrationPreparationRefusal {
  const object = record(value, ["kind", "contractId"], ["reason", "targetHead", "conflictPaths", "requiredGit"]);
  if (object.kind === "integration-unsupported") {
    if (object.requiredGit !== "2.38") fail();
    if ("reason" in object || "targetHead" in object || "conflictPaths" in object) fail();
    return { kind: "integration-unsupported", contractId: decodeContractId(object.contractId), requiredGit: "2.38" };
  }
  if (object.kind !== "integration-failed") fail();
  if ("requiredGit" in object) fail();
  if (
    object.reason !== "not-based-on-target" &&
    object.reason !== "unrelated-histories" &&
    object.reason !== "conflict"
  )
    fail();
  return {
    kind: "integration-failed",
    contractId: decodeContractId(object.contractId),
    reason: object.reason,
    targetHead: decodeSnapshotId(object.targetHead),
    ...(object.conflictPaths === undefined ? {} : { conflictPaths: strings(object.conflictPaths) }),
  };
}

export function decodeCheckoutNotFollowableRefusal(value: unknown): CheckoutNotFollowableRefusal {
  const object = record(value, ["kind", "contractId", "target", "path", "reason", "paths"]);
  if (object.kind !== "checkout-not-followable") fail();
  if (
    object.reason !== "staged" &&
    object.reason !== "dirty-tracked" &&
    object.reason !== "unmerged" &&
    object.reason !== "untracked"
  )
    fail();
  return {
    kind: "checkout-not-followable",
    contractId: decodeContractId(object.contractId),
    target: nonblank(object.target),
    path: nonblank(object.path),
    reason: object.reason,
    paths: strings(object.paths),
  };
}

export function decodeAuditTargetAnswer(value: unknown): AuditTargetAnswer {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "placeable") {
    const object = record(value, ["kind", "ref", "head"]);
    return { kind: "placeable", ref: nonblank(object.ref), head: decodeSnapshotId(object.head) };
  }
  if (kind === "moved") {
    const object = record(value, ["kind", "ref", "expected", "observed"]);
    return {
      kind: "moved",
      ref: nonblank(object.ref),
      expected: decodeSnapshotId(object.expected),
      observed: object.observed === null ? null : decodeSnapshotId(object.observed),
    };
  }
  if (kind === "refused") {
    const object = record(value, ["kind", "refusal"]);
    return { kind: "refused", refusal: decodeCheckoutNotFollowableRefusal(object.refusal) };
  }
  const object = record(value, ["kind", "diagnostic"]);
  if (object.kind !== "failed") fail();
  return { kind: "failed", diagnostic: nonblank(object.diagnostic) };
}

export function decodeGitReconcileLag(value: unknown): ReconcileLag {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "worktree-retained") {
    const object = record(value, ["kind", "path"]);
    return { kind: "worktree-retained", path: nonblank(object.path) };
  }
  if (kind === "worktree-follow-retained") {
    const object = record(value, ["kind", "path", "tender", "head", "reason"], ["paths"]);
    if (
      object.reason !== "head-moved" &&
      object.reason !== "head-attached" &&
      object.reason !== "operation-in-progress" &&
      object.reason !== "unsupported-parent-shape"
    )
      fail();
    const lag: Extract<ReconcileLag, { kind: "worktree-follow-retained" }> = {
      kind: "worktree-follow-retained",
      path: nonblank(object.path),
      tender: decodeGitSnapshotId(object.tender),
      head: decodeGitSnapshotId(object.head),
      reason: object.reason,
      ...(object.paths === undefined ? {} : { paths: strings(object.paths) }),
    };
    return lag;
  }
  if (kind === "unsealed-bytes") {
    const object = record(value, ["kind", "path", "paths"], ["head"]);
    const lag: UnsealedBytes = {
      kind: "unsealed-bytes",
      path: nonblank(object.path),
      paths: strings(object.paths),
      ...(object.head === undefined ? {} : { head: decodeGitSnapshotId(object.head) }),
    };
    return lag;
  }
  if (kind === "target-checkout-retained") {
    const object = record(value, ["kind", "path", "target", "diagnostic"]);
    const lag: TargetCheckoutLag = {
      kind: "target-checkout-retained",
      path: nonblank(object.path),
      target: nonblank(object.target),
      diagnostic: nonblank(object.diagnostic),
    };
    return lag;
  }
  if (kind === "reconcile-failed") {
    const object = record(value, ["kind", "stage", "diagnostic"]);
    if (object.stage !== "observation" && object.stage !== "effect") fail();
    const lag: ReconcileFailure = {
      kind: "reconcile-failed",
      stage: object.stage,
      diagnostic: nonblank(object.diagnostic),
    };
    return lag;
  }
  const object = record(value, ["kind", "phase", "path", "command", "name", "failure"]);
  if (object.kind !== "worktree-hook-failed") fail();
  if (object.phase !== "create" && object.phase !== "destroy") fail();
  const lag: WorktreeHookLag = {
    kind: "worktree-hook-failed",
    phase: object.phase,
    path: nonblank(object.path),
    command: nonnegativeInteger(object.command),
    name: nonblank(object.name),
    failure: decodeHookFailure(object.failure),
  };
  return lag;
}
