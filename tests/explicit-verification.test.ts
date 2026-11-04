import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, KeiyakuError, Repo } from "../src/index.js";
import { gateReports } from "../src/core/facts/gate.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { accepted, commitCandidate, document, present, repositoryWithMain } from "./support/library-verbs.js";

function declarations(scripts: readonly string[]): string {
  return (
    document() +
    "\n## Verification\n\n" +
    scripts.map((script) => `\`\`\`bash timeout=1m\n${script}\n\`\`\``).join("\n\n") +
    "\n"
  );
}

async function fixture(scripts: readonly string[], gates = ["reviewed", "verified"]) {
  const repository = repositoryWithMain();
  const contract = accepted(
    await Keiyaku.with().bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: declarations(scripts),
      gates,
      target: "refs/heads/main",
    }),
  ).value.keiyaku;
  const worktree = await appointedWorktreePath(
    await cachedRepositoryAt(repository.path),
    present(await contract.state()).id,
  );
  commitCandidate(repository, worktree);
  return { repository, contract, worktree };
}

test("explicit checks accumulate on the prospective snapshot and unchanged delivery consumes them", async () => {
  const { contract } = await fixture(["true", "test -f candidate.txt"]);
  const first = accepted(await contract.verify({ index: 1 }));
  assert.deepEqual(
    first.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(present(await contract.state()).delivery, null);
  assert.equal(first.value.checks.length, 1);
  const preview = accepted(await contract.previewDelivery());
  assert.equal(preview.value.candidate.kind, "ready");
  if (preview.value.candidate.kind !== "ready") throw new Error("candidate blocked");
  const prospectiveGate = preview.value.candidate.requirements.gates.find((gate) => gate.gate === "verified")!;
  assert.equal(prospectiveGate.satisfied, false);
  assert.deepEqual(
    prospectiveGate.requirements.map((requirement) => requirement.current.kind),
    ["attested", "missing"],
  );
  accepted(await contract.amend({ markdown: "## Replace: Objective\n\nSame candidate with revised author intent.\n" }));
  const second = accepted(await contract.verify({ index: 2 }));
  assert.equal(second.value.snapshot, first.value.snapshot);
  const delivered = accepted(await contract.deliver());
  assert.equal(delivered.value.integration.snapshot, first.value.snapshot);
  assert.deepEqual(
    delivered.facts.map((fact) => fact.kind),
    ["deliver"],
  );
  assert.equal(delivered.value.gates?.find((gate) => gate.gate === "verified")?.satisfied, true);
  const reviewed = accepted(await contract.review({ verdict: "satisfied" }));
  assert.ok(reviewed.value.completion);
});

test("each declaration executes in fresh scratch and terminal failure preserves later evidence and scenes", async () => {
  const { contract } = await fixture(["echo created > scratch-only", "test -f scratch-only", "exit 7", "true"]);
  const verified = accepted(await contract.verify());
  assert.deepEqual(
    verified.value.checks.map((check) => (check.kind === "terminal" ? check.verdict : check.kind)),
    ["satisfied", "unsatisfied", "unsatisfied", "satisfied"],
  );
  assert.equal(verified.facts.length, 4);
  const scenes = verified.value.checks.flatMap((check) =>
    check.retainedPath === undefined ? [] : [check.retainedPath],
  );
  assert.equal(scenes.length, 2);
  assert.notEqual(scenes[0], scenes[1]);
  assert.ok(scenes.every(existsSync));
  const repeated = accepted(await contract.verify({ index: 2 }));
  assert.equal(repeated.value.checks[0]?.kind, "terminal");
  if (repeated.value.checks[0]?.kind === "terminal") assert.equal(repeated.value.checks[0].admission.kind, "reused");
  assert.ok(existsSync(scenes[1]!));
  await contract.abandon();
  assert.ok(scenes.every((scene) => !existsSync(scene)));
});

test("verify validates selection and dirty capture before executing or admitting", async () => {
  const { repository, contract, worktree } = await fixture(["true"]);
  const state = present(await contract.state());
  const invalid = await contract.verify({ index: 2 });
  assert.equal(invalid.kind, "refused");
  if (invalid.kind === "refused")
    assert.deepEqual(invalid.refusal, {
      kind: "verification-index-out-of-range",
      contractId: state.id,
      index: 2,
      total: 1,
    });
  await assert.rejects(() => contract.verify({ index: 0 }), /positive safe integer/u);
  writeFileSync(join(worktree, "candidate.txt"), "dirty\n");
  const before = repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim();
  const dirty = await contract.verify();
  assert.equal(dirty.kind, "refused");
  if (dirty.kind === "refused") assert.equal(dirty.refusal.kind, "dirty-workspace");
  const checked = accepted(await contract.verify({ includeDirty: true }));
  assert.equal(checked.value.checks[0]?.kind, "terminal");
  assert.equal(repository.run(["-C", worktree, "rev-parse", "HEAD"]).trim(), before);
  assert.equal(readFileSync(join(worktree, "candidate.txt"), "utf8"), "dirty\n");
  assert.equal(present(await contract.state()).delivery, null);
  await contract.abandon();
});

test("the last selected check completes a delivered and reviewed candidate", async () => {
  const { contract } = await fixture(["true", "test -f candidate.txt"]);
  accepted(await contract.deliver());
  accepted(await contract.review({ verdict: "satisfied" }));
  const first = accepted(await contract.verify({ index: 1 }));
  assert.equal(first.value.completion, undefined);
  const last = accepted(await contract.verify({ index: 2 }));
  assert.ok(last.value.completion);
  assert.equal(last.value.completion.integration, first.value.snapshot);
  assert.deepEqual(
    last.facts.map((fact) => fact.kind),
    ["attestation", "claimed"],
  );
  assert.equal(present(await contract.state()).terminal?.kind, "claimed");
});

test("target movement cannot retarget prior check evidence", async () => {
  const { repository, contract } = await fixture(["true", "test -f candidate.txt"]);
  accepted(await contract.deliver());
  const original = accepted(await contract.verify());
  writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const reviewed = accepted(await contract.review({ verdict: "satisfied" }));
  assert.equal(reviewed.value.completion, undefined);
  assert.equal(reviewed.value.gates?.find((gate) => gate.gate === "verified")?.current.kind, "stale");
  const next = accepted(await contract.verify({ index: 1 }));
  assert.notEqual(next.value.snapshot, original.value.snapshot);
  assert.equal(next.value.gates?.find((gate) => gate.gate === "verified")?.satisfied, false);
  const completed = accepted(await contract.verify({ index: 2 }));
  assert.ok(completed.value.completion);
});

test("verify after target movement reuses its prospective snapshot during ordinary completion", async () => {
  const { repository, contract } = await fixture(["true"]);
  accepted(await contract.deliver());
  accepted(await contract.review({ verdict: "satisfied" }));
  writeFileSync(join(repository.path, "target-only.txt"), "moved\n");
  repository.run(["add", "target-only.txt"]);
  repository.run(["commit", "--quiet", "-m", "advance target"]);
  const verified = accepted(await contract.verify());
  assert.ok(verified.value.completion);
  assert.equal(verified.value.completion.integration, verified.value.snapshot);
  assert.deepEqual(
    verified.facts.map((fact) => fact.kind),
    ["attestation", "reintegrated", "claimed"],
  );
});

test("concurrent selected admissions preserve both requirements and repeated checks still execute", async () => {
  const { repository, contract } = await fixture(["true", "test -f candidate.txt"]);
  accepted(await contract.deliver());
  const results = await Promise.all([contract.verify({ index: 1 }), contract.verify({ index: 2 })]);
  assert.ok(results.every((result) => result.kind === "accepted"));
  const verified = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(verified.satisfied, true);
  assert.equal(verified.requirements.length, 2);
  const observations: string[] = [];
  const repeated = accepted(
    await contract.verify(
      { index: 1 },
      {
        observe: (event) => {
          if (event.kind === "verification" && event.observation.kind === "phase")
            observations.push(event.observation.phase);
        },
      },
    ),
  );
  assert.ok(observations.includes("declaration"));
  assert.deepEqual(repeated.facts, []);
  assert.equal(repeated.value.checks[0]?.kind, "terminal");
  if (repeated.value.checks[0]?.kind === "terminal") assert.equal(repeated.value.checks[0].admission.kind, "reused");
  assert.equal(repository.run(["worktree", "list", "--porcelain"]).includes("keiyaku-v4-verify-"), false);
  await contract.abandon();
});

test("cancellation after terminal execution retains the check and stops its admission", async () => {
  const { contract } = await fixture(["true", "printf second", "printf never"]);
  const controller = new AbortController();
  let thirdExecuted = false;
  let result: Awaited<ReturnType<typeof contract.verify>> | undefined;
  try {
    result = await contract.verify(
      { signal: controller.signal },
      {
        observe: (event) => {
          if (event.kind !== "verification" || event.observation.kind !== "phase") return;
          if (event.observation.index === 3 && event.observation.phase === "declaration") thirdExecuted = true;
          if (
            event.observation.index === 2 &&
            event.observation.phase === "declaration" &&
            event.observation.state === "finished"
          )
            controller.abort(new Error("cancel after terminal execution"));
        },
      },
    );
  } catch (error) {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.category, "aborted");
    result = error.outcome as typeof result;
  }
  assert.ok(result && "value" in result && result.value);
  assert.deepEqual(
    result.value.checks.map((check) =>
      check.kind === "terminal" ? [check.index, check.verdict, check.admission.kind] : [check.index, check.kind],
    ),
    [
      [1, "satisfied", "admitted"],
      [2, "satisfied", "stopped"],
    ],
  );
  const second = result.value.checks[1]!;
  assert.ok(second.kind === "terminal" && second.admission.kind === "stopped");
  assert.deepEqual(second.admission.stop, { failure: "cancelled" });
  assert.ok(result.pending.some((pending) => pending.surface === "verification" && pending.required));
  assert.equal(result.facts.filter((fact) => fact.kind === "attestation").length, 1);
  assert.equal(present(await contract.state()).attestations.length, 1);
  assert.equal(thirdExecuted, false);
  await contract.abandon();
});

test("changed failure testimony admits a new attestation while identical testimony reuses it", async () => {
  const { repository, contract } = await fixture(["true"]);
  const output = join(repository.path, "failure-output");
  writeFileSync(output, "first failure");
  accepted(
    await contract.amend({
      markdown: `## Replace: Verification\n\n\`\`\`bash timeout=1m\ncat '${output}'; exit 1\n\`\`\`\n`,
    }),
  );
  accepted(await contract.deliver());
  const first = accepted(await contract.verify()).value.checks[0]!;
  assert.ok(first.kind === "terminal" && first.admission.kind === "admitted");
  writeFileSync(output, "second failure");
  const verified = accepted(await contract.verify());
  const second = verified.value.checks[0]!;
  assert.ok(second.kind === "terminal" && second.admission.kind === "admitted");
  assert.notEqual(second.admission.entry, first.admission.entry);
  assert.match(second.summary ?? "", /second failure/u);
  const state = present(await contract.state());
  assert.equal(state.attestations.length, 2);
  assert.equal(state.attestations.at(-1)?.data.summary, second.summary);
  assert.equal(verified.value.gates?.find((gate) => gate.gate === "verified")?.satisfied, false);
  const repeated = accepted(await contract.verify());
  const check = repeated.value.checks[0]!;
  assert.ok(check.kind === "terminal");
  assert.deepEqual(check.admission, { kind: "reused", entry: second.admission.entry });
  assert.deepEqual(repeated.facts, []);
  await contract.abandon();
});

test("declaration changes preserve independent requirements while reordering preserves all evidence", async () => {
  const { contract } = await fixture(["true", "test -f candidate.txt"]);
  await contract.deliver();
  accepted(await contract.verify());
  const original = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(original.satisfied, true);
  accepted(
    await contract.amend({
      markdown:
        "## Replace: Verification\n\n```bash timeout=1m\ntest -f candidate.txt\n```\n\n```bash timeout=1m\ntrue\n```\n",
    }),
  );
  const reordered = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.equal(reordered.satisfied, true);
  assert.deepEqual(
    reordered.requirements.map((requirement) => requirement.requirement),
    original.requirements.map((requirement) => requirement.requirement).reverse(),
  );
  accepted(
    await contract.amend({
      markdown:
        "## Replace: Verification\n\n```bash timeout=1m\ntest -f candidate.txt\n```\n\n```bash timeout=1m\necho changed\n```\n",
    }),
  );
  const changed = gateReports(present(await contract.state())).reports.find((gate) => gate.gate === "verified")!;
  assert.deepEqual(
    changed.requirements.map((requirement) => requirement.current.kind),
    ["attested", "missing"],
  );
  await contract.abandon();
});
