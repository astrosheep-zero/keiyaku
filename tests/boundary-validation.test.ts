import assert from "node:assert/strict";
import test from "node:test";
import { Repo } from "../src/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

test("package boundary rejects malformed runtime inputs before journal mutation", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = Repo.at({ path: repository.path });
  const before = (await repo.status()).contracts;

  assert.throws(
    () => withGitShim("exit 99", {}, () => Reflect.apply(Repo.at, Repo, [null])),
    TypeError,
  );
  assert.throws(
    () => withGitShim("exit 99", {}, () => Reflect.apply(repo.contract, repo, [{ id: null }])),
    TypeError,
  );
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Reflect.apply(repo.status, repo, [null])),
    TypeError,
  );
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Reflect.apply(repo.status, repo, [{ contract: "bad" }])),
    (error: unknown) => error instanceof TypeError
      && error.message === "contract ID must be kei/<lowercase-machine-contract>",
  );
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Reflect.apply(repo.bind, repo, [{ markdown: null, workspace: "here" }])),
    TypeError,
  );

  assert.deepEqual((await repo.status()).contracts, before);
});

test("amend validates programmer input before observing a missing contract", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = Repo.at({ path: repository.path });
  const contract = repo.contract({ id: "kei/missing" as never });
  const before = (await repo.status()).contracts;

  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Reflect.apply(contract.amend, contract, [{ markdown: "## Append: Context\ntext\n", gates: ["invalid"] }])),
    (error: unknown) => error instanceof TypeError
      && error.message === "gates[0] must be reviewed or verified",
  );
  assert.deepEqual((await repo.status()).contracts, before);
});

test("boundary validation precedes Git and unrepresentable targets stay typed", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = Repo.at({ path: repository.path });
  const invalidTarget = await repo.bind({
    markdown: ["# T", "", "## Context", "C", "", "## Objective", "O", "", "## Design", "D", "", "## Region", "~~~", "src/**", "~~~", "", "## Criteria", "### C", "C", ""].join("\n"),
    target: "bad\0target",
    workspace: "here",
  });
  assert.deepEqual(invalidTarget, { kind: "refused", refusal: { kind: "invalid-target" } });

  const bound = await repo.bind({
    markdown: ["# T", "", "## Context", "C", "", "## Objective", "O", "", "## Design", "D", "", "## Region", "~~~", "src/**", "~~~", "", "## Criteria", "### C", "C", ""].join("\n"),
    workspace: "here",
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => bound.value.deliver({ actor: " " })),
    (error: unknown) => error instanceof TypeError && error.message === "actor must be a nonblank string",
  );
});
