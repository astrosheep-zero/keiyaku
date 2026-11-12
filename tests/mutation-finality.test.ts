import assert from "node:assert/strict";
import test from "node:test";
import type { DeliveryPreviewReport } from "../src/index.js";
import type { ReviewOutcome, AmendOutcome } from "../src/library/contract-outcomes.js";
import type { Review } from "../src/library/outcome.js";
import { InvocationAccumulator } from "../src/library/invocation.js";
import { project, KeiyakuError } from "../src/library/outcome.js";
import { reconcileException } from "../src/library/reconcile.js";
import { concatenatePrivateStateSeatClose } from "../src/git/private-state-seat.js";
import {
  contractId,
  documentKey,
  snapshotId,
  type ContractHead,
  type ContractState,
} from "../src/core/facts/types.js";
const id = contractId("kei/mutation-finality-test");
function outcome(
  progress: InvocationAccumulator,
  value: Review = {},
  operation: "review" | "amend" = "review",
) {
  const result = project<ReviewOutcome | AmendOutcome>(operation, progress.snapshot(), {
    kind: "accepted",
    contractId: id,
    ...value,
  });
  assert.equal(result.kind, "returned");
  assert.ok(result.kind === "returned");
  assert.ok(result.outcome.kind === "accepted");
  return result.outcome;
}

function previewReport(): DeliveryPreviewReport {
  return { kind: "blocked", contractId: id, reason: { kind: "target-missing" } };
}

test("blocked preview is a completed read, not an admitted mutation", () => {
  const result = project("deliver-preview", new InvocationAccumulator().snapshot(), previewReport());
  assert.ok(result.kind === "returned");
  assert.deepEqual(result.outcome, previewReport());
});

test("mutation issues flatten independently owned reconciliation lags without presentation scopes", () => {
  const progress = new InvocationAccumulator();
  progress.recordReconciliation(id, {
    lag: [
      { kind: "worktree-retained", path: "/tmp/terminal" },
      { kind: "unsealed-bytes", path: "/tmp/scratch" },
      {
        kind: "worktree-follow-retained",
        path: "/tmp/dependent",
        reason: "head-moved",
      },
      { kind: "target-checkout-retained", path: "/tmp/main", target: "refs/heads/main", diagnostic: "dirty" },
      { kind: "reconcile-failed", diagnostic: "busy" },
    ],
  });
  assert.deepEqual(outcome(progress).issues, [
    { kind: "worktree-retained", severity: "optional", path: "/tmp/terminal" },
    { kind: "unsealed-bytes", severity: "optional", path: "/tmp/scratch" },
    { kind: "worktree-follow-retained", severity: "optional", path: "/tmp/dependent", reason: "head-moved" },
    { kind: "target-checkout-retained", severity: "required", path: "/tmp/main", target: "refs/heads/main", diagnostic: "dirty" },
    { kind: "reconcile-failed", severity: "required", diagnostic: "busy" },
  ]);
});

test("diagnosed worktree retention absorbs only its identical plain duplicate", () => {
  const other = contractId("kei/different-owner");
  const progress = new InvocationAccumulator();
  progress.recordReconciliation(id, {
    lag: [{ kind: "worktree-retained", path: "/tmp/shared-worktree", diagnostic: "primary removal failure" }],
  });
  progress.recordReconciliation(other, { lag: [{ kind: "worktree-retained", path: "/tmp/shared-worktree" }] });
  assert.deepEqual(outcome(progress).issues?.filter((issue) => issue.kind === "worktree-retained"), [
    { kind: "worktree-retained", severity: "optional", path: "/tmp/shared-worktree", diagnostic: "primary removal failure" },
    { kind: "worktree-retained", severity: "optional", contractId: other, path: "/tmp/shared-worktree" },
  ]);
});

test("merged admissions concatenate every confirmed seat-close lag in order", () => {
  const first = {
    kind: "private-state-seat-close-failed" as const,
    diagnostic: "first seat close failed",
  };
  const second = {
    kind: "private-state-seat-close-failed" as const,
    diagnostic: "second seat close failed",
  };
  const state: ContractState = {
    id: contractId("kei/mutation-finality-test"),
    head: "head" as ContractHead,
    coordinates: { start: snapshotId("base"), workspace: "worktree" },
    terms: {
      document: { bytes: "# Test", key: documentKey("document") },
      segments: [],
      gates: [],
      requirements: {},
      after: [],
    },
    delivery: null,
    currentIntegration: null,
    attestations: [],
    terminal: null,
  };
  const current = {
    kind: "accepted" as const,
    facts: [],
    state,
    journal: [],
    seatClose: [first],
  };
  const next = {
    kind: "accepted" as const,
    facts: [],
    state,
    journal: [],
    seatClose: [second],
  };
  const seatClose = concatenatePrivateStateSeatClose(current.seatClose, next.seatClose);
  assert.deepEqual(seatClose, [first, second]);
  const merged = seatClose === undefined ? next : { ...next, seatClose };
  const progress = new InvocationAccumulator();
  progress.recordResidue(state.id, merged);
  assert.deepEqual(
    outcome(progress, undefined, "amend").issues?.flatMap((issue) =>
      issue.kind === "diagnostic" && issue.severity === "required" ? [issue.diagnostic] : []),
    [first.diagnostic, second.diagnostic],
  );
  assert.deepEqual(
    progress
      .snapshot()
      .effects.filter((effect) => effect.kind === "issue")
      .map((effect) => effect.issue),
    [first, second].map((failure) => ({ kind: "diagnostic", severity: "required", diagnostic: failure.diagnostic })),
  );
});

test("accepted receipts retain ephemeral recovery snapshots in their operation-local shape", () => {
  const progress = new InvocationAccumulator();
  const snapshot = snapshotId("recovery-snapshot");
  progress.recordPhysical(id, {
    effects: [{ kind: "recovery-snapshot", snapshot }],
    lag: [],
  });
  assert.deepEqual(outcome(progress).recoverySnapshots, [{ snapshot }]);
  assert.deepEqual(outcome(progress, undefined, "amend").recoverySnapshots, [snapshot]);
});

test("selected reconcile keeps confirmed worktree creation and ref movement on a later native failure", () => {
  const progress = new InvocationAccumulator();
  progress.recordPhysical(id, { effects: [
    { kind: "worktree", action: "created", path: "/tmp/new-contract-worktree" },
    { kind: "ref", name: "refs/keiyaku/candidate/test", before: "before", after: "after" },
  ], lag: [] });
  const original = new TypeError("later selected reconciliation failure");
  assert.throws(() => reconcileException(original, progress, id), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "internal");
    assert.equal(error.cause, original);
    assert.ok(error.outcome?.kind === "contract");
    assert.equal(error.outcome.contractId, id);
    assert.deepEqual(error.outcome.effects, [
      { kind: "worktree-created", path: "/tmp/new-contract-worktree" },
      { kind: "ref", name: "refs/keiyaku/candidate/test", before: "before", after: "after" },
    ]);
    assert.equal(error.outcome.admitted, undefined);
    assert.equal(error.outcome.issues, undefined);
    return true;
  });
});

test("mutation nuke confirmed seat-close failure remains a typed outcome", async () => {
  const { rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { World } = await import("../src/world.js");
  const { nukeGit } = await import("../src/git/nuke.js");
  const { nukeKeiyaku } = await import("../src/library/nuke.js");
  const { makeGitRepository } = await import("./support/git.js");
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  writeFileSync(join(raw.path, ".git", "info", "exclude"), ".keiyaku/locks/\n");
  try {
    const world = await World.at(raw.path);
    const close = () => {
      throw new Error("nuke seat close failed after publication");
    };
    const outcome = await nukeGit(world, "git", { onPrivateStateSeatClose: close });
    assert.equal("value" in outcome, true);
    assert.deepEqual(outcome.closeLag, {
      kind: "private-state-seat-close-failed",
      diagnostic: "nuke seat close failed after publication",
    });

    raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
    const publicResult = await nukeKeiyaku({ world, confirm: world }, { onPrivateStateSeatClose: close });
    assert.equal(publicResult.kind, "accepted");
    assert.ok(publicResult.kind === "accepted");
    assert.equal(publicResult.refsRemoved, 1);
    assert.deepEqual((publicResult.issues ?? []), [
      {
        kind: "reset-residue",
        diagnostic: "nuke seat close failed after publication",
      },
    ]);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("public refusal and retry are compact operation stops", () => {
  for (const projection of [
    { kind: "refused" as const, contractId: id, reason: { kind: "target-missing" as const } },
    { kind: "retry" as const, contractId: id, reason: "exhausted" as const },
  ]) {
    const result = project("deliver", new InvocationAccumulator().snapshot(), projection);
    assert.ok(result.kind === "returned");
    assert.equal(result.outcome.kind, projection.kind);
    assert.deepEqual(result.outcome, projection);
  }
});

test("the local failure projector never decodes partial owner evidence or masks its original cause", () => {
  const progress = new InvocationAccumulator();
  const native = new TypeError("later programming failure");
  // Owner conclusions can be genuinely incomplete; strict wire decoding is not a local failure gate.
  const scope = {};
  progress.recordDeliveryPreview(id, { scope });
  const first = project("deliver-preview", progress.snapshot(), { kind: "failed", contract: id, error: native });
  assert.ok(first.kind === "failed");
  assert.ok(first.error instanceof KeiyakuError);
  assert.equal(first.error.cause, native);
  assert.equal(first.error.category, "internal");
  assert.equal(first.error.message, native.message);
  progress.recordChannelRetirement(id, new Error("retirement failed"));
  const final = project("deliver-preview", progress.snapshot(), { kind: "failed", contract: id, error: first.error });
  assert.ok(final.kind === "failed");
  assert.ok(final.error instanceof KeiyakuError);
  assert.equal(final.error.cause, first.error);
  assert.equal(first.error.cause, native);
  assert.equal(final.error.category, "internal");
  assert.equal(final.error.message, native.message);
  assert.ok(final.error.outcome?.kind === "contract");
  assert.equal(final.error.outcome.contractId, id);
  assert.equal(final.error.outcome.admitted, undefined);
  assert.equal(final.error.outcome.issues?.length, 1);
  assert.ok(first.error.outcome?.kind === "contract");
  assert.notEqual(final.error, first.error);
  assert.notEqual(first.error.outcome, final.error.outcome);
  assert.equal(first.error.outcome.issues, undefined);
  assert.deepEqual(first.error.outcome.preview, { scope });
  assert.deepEqual(final.error.outcome.preview, { scope });
});
