import assert from "node:assert/strict";
import test from "node:test";
import type { AuditReport } from "../src/index.js";
import { InvocationAccumulator, project, KeiyakuError } from "../src/library/outcome.js";
import { concatenatePrivateStateSeatClose } from "../src/git/private-state-seat.js";
import { contractId, documentKey, snapshotId, type ContractHead, type ContractState } from "../src/core/facts/types.js";
import { mergeAdmissions } from "../src/protocol/operations.js";
const id = contractId("kei/mutation-finality-test");
function outcome(progress: InvocationAccumulator, value: unknown = undefined, operation: "review" | "audit" | "amend" = "review") {
  const result = project(operation, progress.snapshot(), { kind: "accepted", contract: id, head: "head" as ContractHead, value });
  assert.equal(result.kind, "returned");
  assert.ok(result.kind === "returned");
  return result.outcome;
}

function auditReport(): AuditReport {
  return {
    candidate: {
      kind: "blocked",
      refusal: { kind: "target-missing", contractId: contractId("kei/mutation-finality-test") },
    },
    verification: { kind: "satisfied", passed: 1, total: 1 },
    target: { kind: "not-observed" },
  };
}


test("audit terminal verification projects complete", () => {
  assert.deepEqual(outcome(new InvocationAccumulator(), auditReport(), "audit").pending, []);
});

test("mutation lag scopes identify the affected pending action", () => {
  const progress = new InvocationAccumulator();
  progress.recordReconciliation(id, { lag: [
    { kind: "worktree-retained", path: "/tmp/terminal" },
    { kind: "unsealed-bytes", path: "/tmp/scratch", paths: [] },
    { kind: "worktree-follow-retained", path: "/tmp/dependent", tender: snapshotId("tender"), head: snapshotId("head"), reason: "head-moved" },
    { kind: "target-checkout-retained", path: "/tmp/main", target: "refs/heads/main", diagnostic: "dirty" },
    { kind: "reconcile-failed", stage: "effect", diagnostic: "busy" },
  ] });
  assert.deepEqual(outcome(progress).pending, [
    { surface: "continuation", required: true },
    { surface: "placement", required: true },
    { surface: "reconciliation", required: true },
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
    terms: { document: { bytes: "# Test", key: documentKey("document") }, segments: [], gates: [], after: [] },
    bound: null,
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
  const merged = mergeAdmissions(current, next);
  assert.deepEqual(merged.seatClose, [first, second]);
  const seatClose = concatenatePrivateStateSeatClose(current.seatClose, next.seatClose);
  assert.deepEqual(seatClose, [first, second]);
  const progress = new InvocationAccumulator();
  progress.recordResidue(state.id, merged);
  assert.deepEqual(outcome(progress, undefined, "amend").pending, [{ surface: "cleanup", required: false }]);
  assert.deepEqual(progress.snapshot().effects.filter((effect) => effect.kind === "cleanup").map((effect) => effect.issue),
    [first, second].map((failure) => ({ kind: "private-state-seat-close", contractId: state.id, failure })));

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
    assert.equal(publicResult.value.removed.refs, 1);
    assert.deepEqual(publicResult.pending, [{ surface: "reset", required: false }]);
    assert.deepEqual(publicResult.effects, [
      {
        kind: "reset-residue", world, owner: "git",
        diagnostic: "nuke seat close failed after publication",
      },
    ]);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("public refusal and retry are returned no-fact envelopes", () => {
  for (const projection of [
    { kind: "refused" as const, contract: id, refusal: { kind: "target-missing" as const, contractId: id } },
    { kind: "retry" as const, contract: id, reason: { kind: "exhausted" as const } },
  ]) {
    const result = project("deliver", new InvocationAccumulator().snapshot(), projection);
    assert.ok(result.kind === "returned");
    assert.equal(result.outcome.kind, projection.kind);
    assert.deepEqual(result.outcome.facts, []);
    assert.deepEqual(result.outcome.pending, []);
  }
});

test("the local failure projector never decodes partial owner evidence or masks its original cause", () => {
  const progress = new InvocationAccumulator();
  const native = new TypeError("later programming failure");
  // Owner conclusions can be genuinely incomplete; strict wire decoding is not a local failure gate.
  progress.recordAudit(id, { verification: { kind: "satisfied", passed: 1, total: 1 } });
  const first = project("audit", progress.snapshot(), { kind: "failed", contract: id, error: native });
  assert.ok(first.kind === "failed");
  assert.equal(first.error.cause, native);
  assert.equal(first.error.category, "internal");
  Object.defineProperty(first.error, "requestOutcome", { value: "unproven", enumerable: false });
  progress.recordChannelRetirement(id, new Error("retirement failed"));
  const final = project("audit", progress.snapshot(), { kind: "failed", contract: id, error: first.error });
  assert.ok(final.kind === "failed");
  assert.ok(final.error instanceof KeiyakuError);
  assert.equal(final.error.cause, native);
  assert.equal(final.error.category, "internal");
  assert.equal(Object.getOwnPropertyDescriptor(final.error, "requestOutcome")?.value, "unproven");
  assert.equal(final.error.outcome?.effects.length, 1);
  assert.deepEqual(first.error.outcome?.effects, []);
  assert.deepEqual(final.error.outcome?.value, { verification: { kind: "satisfied", passed: 1, total: 1 } });
});
