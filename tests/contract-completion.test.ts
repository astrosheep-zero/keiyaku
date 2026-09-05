import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";
import { bind, commitCandidate, document, repositoryWithMain } from "./support/library-verbs.js";

async function fixture() {
  const repository = repositoryWithMain();
  const contract = await bind(repository);
  const state = await contract.state();
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  commitCandidate(repository, worktree);
  return { repository, contract, state, worktree };
}

async function dependentFixture(diverged: boolean) {
  const { repository, contract: primary, state: initial } = await fixture();
  const dependent = (
    await Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: document().replace("# Library verbs", "# Completion dependent"),
      workspace: "worktree",
      gates: [],
      after: [initial.id],
    })
  ).keiyaku;
  const childState = await dependent.state();
  const childPath = await appointedWorktreePath(await cachedRepositoryAt(repository.path), childState.id);
  if (diverged) {
    writeFileSync(join(childPath, "dependent.txt"), "dependent\n");
    repository.run(["-C", childPath, "add", "dependent.txt"]);
    repository.run(["-C", childPath, "commit", "--quiet", "-m", "dependent candidate"]);
  }
  const childHead = repository.run(["-C", childPath, "rev-parse", "HEAD"]).trim();
  const delivered = await dependent.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected an accepted dependent delivery");
  const placement = delivered.value.placement;
  assert.equal(placement && "refusal" in placement ? placement.refusal.kind : undefined, "prerequisites-unsatisfied");
  await primary.deliver();
  return { repository, primary, initial, dependent, childState, childPath, childHead };
}

test("review before delivery records one leading fact and delivery later claims automatically", async () => {
  const { contract } = await fixture();
  const review = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(review.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(review.value.completion, undefined);
  const placement = review.value.placement;
  assert.equal(placement && "refusal" in placement ? placement.refusal.kind : undefined, "delivery-missing");
  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected an accepted delivery");
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver", "claimed"]);
  assert.ok(delivered.value.completion);
  const state = await contract.state();
  assert.equal(state.terminal?.kind, "claimed");
  assert.equal(delivered.head, state.head);
});

test("review after delivery uses the same completion node without replaying delivery facts", async () => {
  const { contract } = await fixture();
  const delivered = await contract.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("expected an accepted delivery");
  assert.equal(delivered.value.completion, undefined);
  assert.deepEqual(delivered.facts.map((fact) => fact.kind), ["bound", "deliver"]);
  const review = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(review.facts.map((fact) => fact.kind), ["attestation", "claimed"]);
  assert.ok(review.value.completion);
  assert.equal(review.head, (await contract.state()).head);
});

test("an unsatisfied review never requests trailing placement", async () => {
  const { contract } = await fixture();
  await contract.deliver();
  const review = await contract.review({ verdict: "unsatisfied", summary: "not accepted" });
  assert.deepEqual(review.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(review.value.completion, undefined);
  assert.equal(review.value.placement, undefined);
  assert.equal((await contract.state()).terminal, null);
});

test("automatic dependent completion retains only new facts and the primary contract head", async () => {
  const { primary, initial, dependent, childState } = await dependentFixture(false);
  const review = await primary.review({ verdict: "satisfied" });
  assert.deepEqual(review.value.continuation?.claimed, [childState.id], JSON.stringify(review.value.continuation));
  assert.deepEqual(
    review.facts.filter((fact) => fact.contract === initial.id).map((fact) => fact.kind),
    ["attestation", "claimed"],
  );
  assert.equal(review.facts.some((fact) => fact.kind === "deliver" || fact.kind === "bound"), false);
  assert.equal(new Set(review.facts.map((fact) => `${fact.contract}:${fact.entry}`)).size, review.facts.length);
  assert.equal((await dependent.state()).terminal?.kind, "claimed");
  assert.equal(review.head, (await primary.state()).head);
});

test("a diverged dependent keeps its worktree and does not counterfeit completion", async () => {
  const { repository, primary, initial, dependent, childPath, childHead } = await dependentFixture(true);
  const review = await primary.review({ verdict: "satisfied" });
  assert.ok(review.value.completion);
  assert.deepEqual(review.value.continuation?.claimed, []);
  assert.ok(review.lags.some((lag) => "path" in lag && lag.path === childPath));
  assert.equal(review.facts.every((fact) => fact.contract === initial.id), true);
  assert.equal((await dependent.state()).terminal, null);
  assert.equal(repository.run(["-C", childPath, "rev-parse", "HEAD"]).trim(), childHead);
  assert.equal(readFileSync(join(childPath, "dependent.txt"), "utf8"), "dependent\n");
  assert.equal(review.head, (await primary.state()).head);
});
