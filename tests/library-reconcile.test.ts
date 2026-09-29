import assert from "node:assert/strict";
import test from "node:test";
import { snapshotId } from "../src/core/facts/types.js";
import {
  reconcileLagIsFailure,
  reconcileLagScope,
  type ReconcileCompletion,
  type ReconcileLagScope,
} from "../src/library/reconcile.js";

test("reconcile lag classification covers scope and failure for every current lag kind", () => {
  type Lag = ReconcileCompletion["lag"][number];
  const fixtures: readonly [Lag, ReconcileLagScope, boolean][] = [
    [{ kind: "worktree-retained", path: "/tmp/worktree" }, "none", false],
    [
      {
        kind: "worktree-follow-retained",
        path: "/tmp/worktree",
        tender: snapshotId("tender"),
        head: snapshotId("head"),
        reason: "head-moved",
      },
      "continuation",
      false,
    ],
    [{ kind: "unsealed-bytes", path: "/tmp/worktree", paths: ["file.txt"] }, "none", false],
    [{ kind: "target-checkout-retained", path: "/tmp/target", target: "refs/heads/main", diagnostic: "retained" }, "placement", true],
    [
      {
        kind: "worktree-hook-failed",
        phase: "create",
        path: "/tmp/worktree",
        command: 0,
        name: "prepare",
        failure: { kind: "spawn-error", diagnostic: "failed" },
      },
      "reconciliation",
      true,
    ],
    [{ kind: "reconcile-failed", stage: "effect", diagnostic: "failed" }, "reconciliation", true],
    [
      {
        kind: "contract-file-failed",
        worktree: "/tmp/worktree",
        path: ".keiyaku/KEIYAKU.md",
        diagnostic: "failed",
      },
      "reconciliation",
      true,
    ],
  ];

  assert.deepEqual(
    fixtures.map(([lag]) => [lag.kind, reconcileLagScope(lag), reconcileLagIsFailure(lag)]),
    fixtures.map(([lag, scope, failure]) => [lag.kind, scope, failure]),
  );
});
