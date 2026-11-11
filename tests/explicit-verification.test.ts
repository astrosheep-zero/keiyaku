import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keis, KeiyakuError, Repo } from "../src/index.js";
import { gateReports } from "../src/core/facts/gate.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { accepted, commitCandidate, document, present, repositoryWithMain } from "./support/library-verbs.js";

function declarations(scripts: readonly string[]): string {
  return document() + "\n## Verification\n\n" +
    scripts.map((script) => `\`\`\`bash timeout=1m\n${script}\n\`\`\``).join("\n\n") + "\n";
}

async function fixture(scripts: readonly string[], gates = ["reviewed", "verified"]) {
  const repository = repositoryWithMain();
  const contract = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    markdown: declarations(scripts), gates, target: "refs/heads/main",
  })).kei;
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), present(await contract.state()).id);
  commitCandidate(repository, worktree);
  return { repository, contract, worktree };
}

test("explicit checks accumulate on the prospective snapshot and unchanged delivery consumes them", async () => {
  const { contract } = await fixture(["true", "test -f candidate.txt"]);
  const first = accepted(await contract.verify({ index: 1 }));
  assert.equal(first.checks.length, 1);
  assert.equal(first.checks[0]?.index, 1);
  assert.equal(first.checks[0]?.kind, "terminal");
  assert.equal(first.checks[0]?.admission, undefined);
  assert.equal(present(await contract.state()).attestations.length, 1);
  assert.equal(present(await contract.state()).delivery, null);
  const preview = await contract.previewDelivery();
  assert.ok(preview.kind === "ready");
  assert.equal(preview.unmetGates?.length, 2);
  assert.deepEqual(preview.unmetGates?.map(({ state }) => state), ["missing", "missing"]);
  // Both review and the second check are unmet; the first check is not retransmitted.
  assert.equal(preview.unmetGates?.some(({ requirement }) => requirement === first.checks[0]?.requirement), false);
  accepted(await contract.amend({ markdown: "## Replace: Objective\n\nSame candidate with revised author intent.\n" }));
  const second = accepted(await contract.verify({ index: 2 }));
  assert.equal(second.snapshot, first.snapshot);
  const delivered = accepted(await contract.deliver());
  assert.equal(delivered.integration, first.snapshot);
  assert.ok(delivered.placement?.kind === "gates-unsatisfied");
  const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Verification review passed" }));
  assert.equal(reviewed.placement?.kind, "placed");
  assert.equal(present(await contract.state()).terminal?.kind, "claimed");
});

test("review-only Contracts without declarations refuse verify and retain the delivery lifecycle", async () => {
  const repository = repositoryWithMain();
  const contract = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    markdown: document(), gates: ["reviewed"], target: "refs/heads/main",
  })).kei;
  const before = present(await contract.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), before.id);
  commitCandidate(repository, worktree);
  const invalid = await contract.verify();
  assert.ok(invalid.kind === "refused");
  assert.equal(invalid.reason.kind, "verification-declaration-invalid");
  assert.deepEqual(present(await contract.state()), before);
  assert.equal((await contract.previewDelivery()).kind, "ready");
  const delivered = accepted(await contract.deliver());
  assert.ok(delivered.placement?.kind === "gates-unsatisfied");
  assert.deepEqual(delivered.placement.unmet.map(({ gate }) => gate), ["reviewed"]);
  const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Review without declarations" }));
  assert.equal(reviewed.placement?.kind, "placed");
  assert.equal(present(await contract.state()).terminal?.kind, "claimed");
});

test("each declaration executes in fresh scratch and terminal failure preserves later evidence and scenes", async () => {
  const { contract } = await fixture(["echo created > scratch-only", "test -f scratch-only", "exit 7", "true"]);
  const verified = accepted(await contract.verify());
  assert.deepEqual(verified.checks.map((check) => check.kind === "terminal" ? check.verdict : check.kind),
    ["satisfied", "unsatisfied", "unsatisfied", "satisfied"]);
  assert.equal(present(await contract.state()).attestations.length, 4);
  const scenes = verified.checks.flatMap((check) => check.retainedPath === undefined ? [] : [check.retainedPath]);
  assert.equal(scenes.length, 2);
  assert.notEqual(scenes[0], scenes[1]);
  assert.ok(scenes.every(existsSync));
  const repeated = accepted(await contract.verify({ index: 2 }));
  assert.equal(repeated.checks[0]?.kind, "terminal");
  if (repeated.checks[0]?.kind === "terminal") assert.equal(repeated.checks[0].admission, "reused");
  assert.equal(present(await contract.state()).attestations.length, 4);
  assert.ok(existsSync(scenes[1]!));
  await contract.abandon();
  assert.ok(scenes.every((scene) => !existsSync(scene)));
});

test("verify validates selection and dirty capture before executing or admitting", async () => {
  const { repository, contract, worktree } = await fixture(["true"]);
  const state = present(await contract.state());
  const invalid = await contract.verify({ index: 2 });
  assert.ok(invalid.kind === "refused");
  assert.deepEqual(invalid.reason, { kind: "verification-index-out-of-range", total: 1 });
  assert.equal(invalid.contractId, state.id);
  await assert.rejects(() => contract.verify({ index: 0 }), /positive safe integer/u);
  writeFileSync(join(worktree, "candidate.txt"), "dirty\n");
  const before = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const dirty = await contract.verify();
  assert.ok(dirty.kind === "refused");
  assert.equal(dirty.reason.kind, "dirty-workspace");
  assert.equal(present(await contract.state()).attestations.length, 0);
  const checked = accepted(await contract.verify({ includeDirty: true }));
  assert.equal(checked.checks[0]?.kind, "terminal");
  assert.equal(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim(), before);
  assert.equal(readFileSync(join(worktree, "candidate.txt"), "utf8"), "dirty\n");
  assert.equal(present(await contract.state()).delivery, null);
  await contract.abandon();
});

test("the last selected check completes a delivered and reviewed candidate", async () => {
  const { contract } = await fixture(["true", "test -f candidate.txt"]);
  accepted(await contract.deliver());
  accepted(await contract.review({ verdict: "satisfied", summary: "Verification review passed" }));
  const first = accepted(await contract.verify({ index: 1 }));
  assert.equal(first.placement?.kind, "gates-unsatisfied");
  const last = accepted(await contract.verify({ index: 2 }));
  assert.ok(last.placement?.kind === "placed");
  assert.equal(last.placement.integration, first.snapshot);
  assert.equal(present(await contract.state()).attestations.length, 3);
  assert.equal(present(await contract.state()).terminal?.kind, "claimed");
});

test("target movement cannot retarget prior check evidence", async () => {
  const { repository, contract } = await fixture(["true", "test -f candidate.txt"]);
  accepted(await contract.deliver());
  const original = accepted(await contract.verify());
  writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const reviewed = accepted(await contract.review({ verdict: "satisfied", summary: "Verification review passed" }));
  assert.ok(reviewed.placement?.kind === "gates-unsatisfied");
  const gate = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(gate.current.kind, "stale");
  const next = accepted(await contract.verify({ index: 1 }));
  assert.notEqual(next.snapshot, original.snapshot);
  assert.equal(next.placement?.kind, "gates-unsatisfied");
  const completed = accepted(await contract.verify({ index: 2 }));
  assert.equal(completed.placement?.kind, "placed");
});

test("verify after target movement reuses its prospective snapshot during ordinary completion", async () => {
  const { repository, contract } = await fixture(["true"]);
  accepted(await contract.deliver());
  accepted(await contract.review({ verdict: "satisfied", summary: "Verification review passed" }));
  writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const verified = accepted(await contract.verify());
  assert.ok(verified.placement?.kind === "placed");
  assert.equal(verified.placement.integration, verified.snapshot);
  assert.equal(present(await contract.state()).currentIntegration?.snapshot, verified.snapshot);
});

test("concurrent selected admissions preserve both requirements and repeated checks still execute", async () => {
  const { repository, contract } = await fixture(["true", "test -f candidate.txt"]);
  accepted(await contract.deliver());
  const results = await Promise.all([contract.verify({ index: 1 }), contract.verify({ index: 2 })]);
  const selected = results.map((result) => accepted(result).checks[0]!);
  assert.deepEqual(selected.map(({ index }) => index), [1, 2]);
  assert.notEqual(selected[0]?.requirement, selected[1]?.requirement);
  const state = present(await contract.state());
  const verified = gateReports(state).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(verified.satisfied, true);
  assert.equal(verified.requirements.length, 2);
  assert.deepEqual(selected.map(({ requirement }) => requirement), verified.requirements.map(({ requirement }) => requirement));
  const observations: string[] = [];
  const repeated = accepted(await contract.verify({ index: 1 }, { observe: (event) => {
    if (event.kind === "verification" && event.observation.kind === "phase") observations.push(event.observation.phase);
  } }));
  assert.ok(observations.includes("declaration"));
  assert.equal(repeated.checks[0]?.kind, "terminal");
  if (repeated.checks[0]?.kind === "terminal") assert.equal(repeated.checks[0].admission, "reused");
  assert.equal(present(await contract.state()).attestations.length, state.attestations.length);
  assert.equal(repository.run(["worktree", "list", "--porcelain"]).includes("keiyaku-v4-verify-"), false);
  await contract.abandon();
});

test("cancellation after terminal execution retains the check and stops its admission", async () => {
  const { contract } = await fixture(["true", "printf second", "printf never"]);
  const controller = new AbortController();
  let thirdExecuted = false;
  let result;
  try {
    result = await contract.verify({ signal: controller.signal }, { observe: (event) => {
      if (event.kind !== "verification" || event.observation.kind !== "phase") return;
      if (event.observation.index === 3 && event.observation.phase === "declaration") thirdExecuted = true;
      if (event.observation.index === 2 && event.observation.phase === "declaration" && event.observation.state === "finished")
        controller.abort(new Error("cancel after terminal execution"));
    } });
  } catch (error) {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "aborted");
    assert.ok(error.outcome?.kind === "contract");
    result = error.outcome;
  }
  assert.ok(result && "checks" in result && result.checks);
  assert.deepEqual(result.checks.map((check) => check.kind === "terminal"
    ? [check.index, check.verdict, check.admission] : [check.index, check.kind]),
  [[1, "satisfied", undefined], [2, "satisfied", { kind: "cancelled" }]]);
  assert.equal(present(await contract.state()).attestations.length, 1);
  assert.equal(thirdExecuted, false);
  await contract.abandon();
});

test("changed failure testimony admits a new attestation while identical testimony reuses it", async () => {
  const { repository, contract } = await fixture(["true"]);
  const output = join(repository.path, "failure-output");
  writeFileSync(output, "first failure");
  accepted(await contract.amend({ markdown: `## Replace: Verification\n\n\`\`\`bash timeout=1m\ncat '${output}'; exit 1\n\`\`\`\n` }));
  accepted(await contract.deliver());
  const first = accepted(await contract.verify()).checks[0]!;
  assert.ok(first.kind === "terminal" && first.admission === undefined);
  const firstState = present(await contract.state());
  writeFileSync(output, "second failure");
  const verified = accepted(await contract.verify());
  const second = verified.checks[0]!;
  assert.ok(second.kind === "terminal" && second.verdict === "unsatisfied" && second.admission === undefined);
  assert.match(second.summary, /second failure/u);
  const state = present(await contract.state());
  assert.equal(state.attestations.length, 2);
  assert.notEqual(state.attestations.at(-1)?.entry, firstState.attestations.at(-1)?.entry);
  assert.equal(state.attestations.at(-1)?.data.summary, second.summary);
  assert.equal(verified.placement?.kind, "gates-unsatisfied");
  const repeated = accepted(await contract.verify());
  const check = repeated.checks[0]!;
  assert.ok(check.kind === "terminal");
  assert.equal(check.admission, "reused");
  assert.equal(present(await contract.state()).attestations.length, 2);
  await contract.abandon();
});

test("declaration changes preserve independent requirements while reordering preserves all evidence", async () => {
  const { contract } = await fixture(["true", "test -f candidate.txt"]);
  await contract.deliver();
  accepted(await contract.verify());
  const original = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(original.satisfied, true);
  accepted(await contract.amend({ markdown:
    "## Replace: Verification\n\n```bash timeout=1m\ntest -f candidate.txt\n```\n\n```bash timeout=1m\ntrue\n```\n" }));
  const reordered = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(reordered.satisfied, true);
  assert.deepEqual(reordered.requirements.map(({ requirement }) => requirement), original.requirements.map(({ requirement }) => requirement).reverse());
  accepted(await contract.amend({ markdown:
    "## Replace: Verification\n\n```bash timeout=1m\ntest -f candidate.txt\n```\n\n```bash timeout=1m\necho changed\n```\n" }));
  const changed = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.deepEqual(changed.requirements.map(({ current }) => current.kind), ["attested", "missing"]);
  await contract.abandon();
});
