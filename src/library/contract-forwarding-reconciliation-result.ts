import { snapshotId } from "../core/facts/types.js";

type ResultRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): ResultRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as ResultRecord) : null;
}

function exactResultKeys(value: ResultRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function nonblank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
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

function worktreeEffect(effect: ResultRecord): boolean {
  if (["created", "removed", "unchanged"].includes(effect.action as string)) {
    return exactResultKeys(effect, ["action", "kind", "path"]) && nonblank(effect.path);
  }
  return (
    effect.action === "followed" &&
    exactResultKeys(effect, ["action", "after", "before", "kind", "path"]) &&
    nonblank(effect.path) &&
    canonicalSnapshot(effect.before) &&
    canonicalSnapshot(effect.after)
  );
}

function recoverySnapshotEffect(effect: ResultRecord): boolean {
  return (
    exactResultKeys(effect, ["action", "kind", "retention", "snapshot"]) &&
    effect.action === "created" &&
    effect.retention === "ephemeral" &&
    canonicalSnapshot(effect.snapshot)
  );
}

function targetCheckoutEffect(effect: ResultRecord): boolean {
  return (
    exactResultKeys(effect, ["action", "kind", "path", "target"]) &&
    nonblank(effect.path) &&
    nonblank(effect.target) &&
    (effect.action === "followed" || effect.action === "recovered")
  );
}

function contractFileEffect(effect: ResultRecord): boolean {
  return (
    exactResultKeys(effect, ["action", "kind", "path"]) &&
    nonblank(effect.path) &&
    ["created", "updated", "unchanged", "removed"].includes(effect.action as string)
  );
}

function refEffect(effect: ResultRecord): boolean {
  return (
    exactResultKeys(effect, ["action", "after", "before", "kind", "name"]) &&
    nonblank(effect.name) &&
    ["created", "updated", "removed", "unchanged"].includes(effect.action as string) &&
    (effect.before === null || nonblank(effect.before)) &&
    (effect.after === null || nonblank(effect.after))
  );
}

const reconciliationEffectVariants: Readonly<Record<string, (effect: ResultRecord) => boolean>> = {
  worktree: worktreeEffect,
  "recovery-snapshot": recoverySnapshotEffect,
  "target-checkout": targetCheckoutEffect,
  "contract-file": contractFileEffect,
  ref: refEffect,
};

export function reconciliationEffect(value: unknown): boolean {
  const effect = record(value);
  if (effect === null || typeof effect.kind !== "string") return false;
  return reconciliationEffectVariants[effect.kind]?.(effect) ?? false;
}

function worktreeRetainedLag(lag: ResultRecord): boolean {
  return exactResultKeys(lag, ["kind", "path"]) && nonblank(lag.path);
}

function worktreeFollowRetainedLag(lag: ResultRecord): boolean {
  const expected = ["head", "kind", "path", "reason", "tender", ...(lag.paths === undefined ? [] : ["paths"])];
  return (
    exactResultKeys(lag, expected) &&
    nonblank(lag.path) &&
    canonicalSnapshot(lag.tender) &&
    canonicalSnapshot(lag.head) &&
    ["head-moved", "head-attached", "operation-in-progress", "unsupported-parent-shape"].includes(
      lag.reason as string,
    ) &&
    (lag.paths === undefined || (Array.isArray(lag.paths) && lag.paths.every(nonblank)))
  );
}

function unsealedBytesLag(lag: ResultRecord): boolean {
  const expected = ["kind", "path", "paths", ...(lag.head === undefined ? [] : ["head"])];
  return (
    exactResultKeys(lag, expected) &&
    nonblank(lag.path) &&
    Array.isArray(lag.paths) &&
    lag.paths.every(nonblank) &&
    (lag.head === undefined || canonicalSnapshot(lag.head))
  );
}

function targetCheckoutRetainedLag(lag: ResultRecord): boolean {
  return (
    exactResultKeys(lag, ["diagnostic", "kind", "path", "target"]) &&
    nonblank(lag.diagnostic) &&
    nonblank(lag.path) &&
    nonblank(lag.target)
  );
}

function reconcileFailedLag(lag: ResultRecord): boolean {
  return (
    exactResultKeys(lag, ["diagnostic", "kind", "stage"]) &&
    nonblank(lag.diagnostic) &&
    (lag.stage === "observation" || lag.stage === "effect")
  );
}

function hookFailedLag(lag: ResultRecord): boolean {
  const failure = record(lag.failure);
  return (
    exactResultKeys(lag, ["command", "failure", "kind", "name", "path", "phase"]) &&
    typeof lag.command === "number" &&
    Number.isSafeInteger(lag.command) &&
    lag.command >= 0 &&
    nonblank(lag.name) &&
    nonblank(lag.path) &&
    (lag.phase === "create" || lag.phase === "destroy") &&
    failure !== null &&
    typeof failure.kind === "string"
  );
}

const reconciliationLagVariants: Readonly<Record<string, (lag: ResultRecord) => boolean>> = {
  "worktree-retained": worktreeRetainedLag,
  "worktree-follow-retained": worktreeFollowRetainedLag,
  "unsealed-bytes": unsealedBytesLag,
  "target-checkout-retained": targetCheckoutRetainedLag,
  "reconcile-failed": reconcileFailedLag,
  "worktree-hook-failed": hookFailedLag,
};

export function reconciliationLag(value: unknown): boolean {
  const lag = record(value);
  if (lag === null || typeof lag.kind !== "string") return false;
  return reconciliationLagVariants[lag.kind]?.(lag) ?? false;
}
