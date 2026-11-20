import assert from "node:assert/strict";
import test from "node:test";
import { InvocationAccumulator } from "../src/library/invocation.js";
import { project, KeiyakuError } from "../src/library/outcome.js";
import { SqliteTransactionLockError } from "../src/coordination/sqlite-transaction-lock.js";
import { contractId, snapshotId } from "../src/core/facts/types.js";

const id = contractId("kei/mutation-finality-test");

test("mutation nuke confirmed seat-close failure remains a typed outcome", async () => {
  const { rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { World } = await import("../src/world.js");
  const { nukeGit } = await import("../src/git/nuke.js");
  const { nukeWithGit } = await import("../src/library/nuke.js");
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
      throw new SqliteTransactionLockError("nuke seat close failed after publication", "release-failed");
    };
    const outcome = await nukeGit(world, "git", { onPrivateStateSeatClose: close });
    assert.equal("value" in outcome, true);
    assert.deepEqual(outcome.closeLag, {
      kind: "private-state-seat-close-failed",
      diagnostic: "nuke seat close failed after publication",
    });

    raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
    const publicResult = await nukeWithGit({ world, confirm: world }, { onPrivateStateSeatClose: close });
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

test("repeated failure projection preserves confirmed recovery evidence and the original cause", () => {
  const progress = new InvocationAccumulator();
  const native = new TypeError("later programming failure");
  const snapshot = snapshotId("ref-free-recovery");
  progress.recordPhysical(id, { effects: [{ kind: "recovery-snapshot", snapshot }], lag: [] });
  const first = project("abandon", progress.snapshot(), { kind: "failed", contract: id, error: native });
  assert.ok(first.kind === "failed");
  assert.ok(first.error instanceof KeiyakuError);
  progress.recordStop({ kind: "execution-stopped", contractId: id, reason: "failed", diagnostic: "later read failed" });
  const final = project("abandon", progress.snapshot(), { kind: "failed", contract: id, error: first.error });
  assert.ok(final.kind === "failed");
  assert.ok(final.error instanceof KeiyakuError);
  assert.equal(final.error.cause, first.error);
  assert.equal(first.error.cause, native);
  assert.equal(final.error.category, "internal");
  assert.equal(final.error.message, native.message);
  assert.deepEqual(final.error.outcome, {
    kind: "contract",
    contractId: id,
    effects: [{ kind: "recovery-snapshot", snapshot }],
    issues: [{ kind: "execution-stopped", severity: "required", reason: "failed", diagnostic: "later read failed" }],
  });
  assert.ok(first.error.outcome?.kind === "contract");
  assert.equal(first.error.outcome.issues, undefined);
});
