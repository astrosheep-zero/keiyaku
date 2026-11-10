import assert from "node:assert/strict";
import test from "node:test";
import type { ReconciliationLag } from "../src/library/outcome.js";
import {
  reconcileLagIsFailure,
  reconcileLagScope,
  type ReconcileLagScope,
} from "../src/library/reconcile.js";

test("reconcile lag classification covers scope and failure for every current lag kind", () => {
  type Lag = ReconciliationLag;
  const fixtures: readonly [Lag, ReconcileLagScope, boolean][] = [
    [{ kind: "worktree-retained", path: "/tmp/worktree" }, "none", false],
    [
      {
        kind: "worktree-follow-retained",
        path: "/tmp/worktree",
        reason: "head-moved",
      },
      "continuation",
      false,
    ],
    [{ kind: "unsealed-bytes", path: "/tmp/worktree" }, "none", false],
    [{ kind: "target-checkout-retained", path: "/tmp/target", target: "refs/heads/main", diagnostic: "retained" }, "placement", true],
    [
      {
        kind: "worktree-hook-failed",
        phase: "create",
        path: "/tmp/worktree",
        name: "prepare",
        diagnostic: "failed",
      },
      "reconciliation",
      true,
    ],
    [{ kind: "reconcile-failed", diagnostic: "failed" }, "reconciliation", true],
    [
      {
        kind: "contract-file-failed",
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
