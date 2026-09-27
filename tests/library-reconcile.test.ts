import assert from "node:assert/strict";
import test from "node:test";
import { snapshotId } from "../src/core/facts/types.js";
import { reconcileLagIsFailure, type ReconcileCompletion } from "../src/library/reconcile.js";

test("reconcile lag failure classification covers every current lag kind", () => {
  type Lag = ReconcileCompletion["lag"][number];
  const fixtures: readonly [Lag, boolean][] = [
    [{ kind: "worktree-retained", path: "/tmp/worktree" }, false],
    [
      {
        kind: "worktree-follow-retained",
        path: "/tmp/worktree",
        tender: snapshotId("tender"),
        head: snapshotId("head"),
        reason: "head-moved",
      },
      false,
    ],
    [{ kind: "unsealed-bytes", path: "/tmp/worktree", paths: ["file.txt"] }, false],
    [{ kind: "target-checkout-retained", path: "/tmp/target", target: "refs/heads/main", diagnostic: "retained" }, true],
    [
      {
        kind: "worktree-hook-failed",
        phase: "create",
        path: "/tmp/worktree",
        command: 0,
        name: "prepare",
        failure: { kind: "spawn-error", diagnostic: "failed" },
      },
      true,
    ],
    [{ kind: "reconcile-failed", stage: "effect", diagnostic: "failed" }, true],
    [
      {
        kind: "contract-file-failed",
        worktree: "/tmp/worktree",
        path: ".keiyaku/KEIYAKU.md",
        diagnostic: "failed",
      },
      true,
    ],
  ];

  assert.deepEqual(
    fixtures.map(([lag]) => [lag.kind, reconcileLagIsFailure(lag)]),
    fixtures.map(([lag, expected]) => [lag.kind, expected]),
  );
});
