import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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

test("review before delivery records one leading fact and delivery later claims automatically", async () => {
  const { contract } = await fixture();
  const review = await contract.review({ verdict: "satisfied" });
  assert.deepEqual(review.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(review.value.completion, undefined);
  assert.equal(review.value.placement && "refusal" in review.value.placement
    ? review.value.placement.refusal.kind : undefined, "delivery-missing");
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
  const { repository, contract: primary, state: initial } = await fixture();
  const dependent = (await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document().replace("# Library verbs", "# Completion dependent"),
    workspace: "worktree",
    gates: [],
    after: [initial.id],
  })).keiyaku;
  const childState = await dependent.state();
  const childPath = await appointedWorktreePath(await cachedRepositoryAt(repository.path), childState.id);
  writeFileSync(join(childPath, "dependent.txt"), "dependent\n");
  repository.run(["-C", childPath, "add", "dependent.txt"]);
  repository.run(["-C", childPath, "commit", "--quiet", "-m", "dependent candidate"]);
  await dependent.deliver();
  await primary.deliver();
  const review = await primary.review({ verdict: "satisfied" });
  assert.deepEqual(review.value.continuation?.claimed, [childState.id]);
  assert.deepEqual(review.facts.filter((fact) => fact.contract === initial.id).map((fact) => fact.kind),
    ["attestation", "claimed"]);
  assert.equal(review.facts.some((fact) => fact.kind === "deliver" || fact.kind === "bound"), false);
  assert.equal(new Set(review.facts.map((fact) => `${fact.contract}:${fact.entry}`)).size, review.facts.length);
  assert.equal((await dependent.state()).terminal?.kind, "claimed");
  assert.equal(review.head, (await primary.state()).head);
});
