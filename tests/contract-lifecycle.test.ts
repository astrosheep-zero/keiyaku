import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

/** A committed candidate whose configured scratch setup always fails, producing a Verification runtime stop. */
function runtimeStopSettings(): string {
  return JSON.stringify({
    worktree: {
      create: [{ name: "reject-candidate", argv: [process.execPath, "-e", "process.exit(7)"], timeoutMs: 5_000 }],
    },
  });
}

async function bindAndCommit(options: { gates: readonly string[]; verification: string; runtimeStop?: boolean }) {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(options.verification),
    workspace: "worktree",
    gates: options.gates,
  });
  const state = await bound.keiyaku.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  const paths = ["candidate.txt"];
  if (options.runtimeStop === true) {
    mkdirSync(join(worktree, ".keiyaku"), { recursive: true });
    writeFileSync(join(worktree, ".keiyaku", "settings.json"), runtimeStopSettings());
    paths.push(".keiyaku/settings.json");
  }
  repository.run(["-C", worktree, "add", ...paths]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  return { repository, keiyaku: bound.keiyaku, state };
}

function assertRuntimeStop(value: unknown): void {
  assert.ok(value !== undefined && typeof value === "object" && "failure" in value);
  assert.equal((value as { failure: unknown }).failure, "environment-failure");
}

describe("contract-lifecycle verification blocking", { concurrency: 3 }, () => {
  test("no gate does not make a failing Verification an implicit blocker", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 1" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assert.deepEqual(delivered.value.completion?.verification, { mode: "ran", verdict: "unsatisfied" });
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("no gate does not make a stopped Verification an implicit blocker and retains its typed stop", async () => {
    const { keiyaku } = await bindAndCommit({ gates: [], verification: "exit 0", runtimeStop: true });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assertRuntimeStop(delivered.value.verification);
    assert.equal(delivered.value.completion?.verification, undefined);
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("reviewed is independent of a failing Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["reviewed"], verification: "exit 1" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.deepEqual(placement.refusal, {
      kind: "gates-unsatisfied",
      contractId: state.id,
      unmet: [{ gate: "reviewed", current: { kind: "missing" } }],
    });
    assert.equal((await keiyaku.state()).terminal, null);

    const reviewed = await keiyaku.review({ verdict: "satisfied" });
    assert.equal(reviewed.kind, "accepted");
    assert.equal((await keiyaku.state()).terminal?.kind, "claimed");
  });

  test("verified blocks an unsatisfied Verification", async () => {
    const { keiyaku, state } = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    const placement = delivered.value.placement;
    assert.ok(placement !== undefined && "refusal" in placement);
    assert.equal(placement.refusal.kind, "gates-unsatisfied");
    if (placement.refusal.kind === "gates-unsatisfied") {
      assert.deepEqual(placement.refusal.unmet.map((report) => report.gate), ["verified"]);
      assert.equal(state.id, placement.refusal.contractId);
    }
    assert.equal((await keiyaku.state()).terminal, null);
  });

  test("verified blocks a stopped Verification with its own typed stop", async () => {
    const { keiyaku } = await bindAndCommit({ gates: ["verified"], verification: "exit 0", runtimeStop: true });
    const delivered = await keiyaku.deliver();
    assert.ok(delivered.kind === "accepted", JSON.stringify(delivered));
    assertRuntimeStop(delivered.value.verification);
    assert.equal((await keiyaku.state()).terminal, null);
  });

  test("a reused unsatisfied Verification blocks only when verified is selected", async () => {
    const reviewed = await bindAndCommit({ gates: ["reviewed"], verification: "exit 1" });
    await reviewed.keiyaku.deliver();
    const reused = await reviewed.keiyaku.deliver();
    assert.ok(reused.kind === "accepted", JSON.stringify(reused));
    assert.equal(reused.value.verificationReuse?.verdict, "unsatisfied");
    assert.equal((await reviewed.keiyaku.state()).terminal, null);

    const satisfiedReview = await reviewed.keiyaku.review({ verdict: "satisfied" });
    assert.equal(satisfiedReview.kind, "accepted");
    assert.equal((await reviewed.keiyaku.state()).terminal?.kind, "claimed");

    const verified = await bindAndCommit({ gates: ["verified"], verification: "exit 1" });
    await verified.keiyaku.deliver();
    const blocked = await verified.keiyaku.deliver();
    assert.ok(blocked.kind === "accepted", JSON.stringify(blocked));
    assert.equal(blocked.value.verificationReuse?.verdict, "unsatisfied");
    assert.equal((await verified.keiyaku.state()).terminal, null);
  });
});
