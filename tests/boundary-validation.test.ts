import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { Repo } from "../src/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function assertionsIn(path: string): readonly number[] {
  const source = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(file) === "const")) {
      lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    if (ts.isTypeAssertionExpression(node)) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return lines;
}

test("package boundary validation does not cast unknown input into domain values", () => {
  for (const path of ["src/library/keiyaku.ts", "src/cli/invoke.ts"]) {
    assert.deepEqual(assertionsIn(path), [], `${path} contains an input-boundary type assertion`);
  }
});

test("package boundary rejects malformed runtime inputs before journal mutation", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = Repo.at({ path: repository.path });
  const before = (await repo.status()).contracts;

  assert.throws(() => Reflect.apply(Repo.at, Repo, [null]), TypeError);
  assert.throws(() => Reflect.apply(repo.contract, repo, [{ id: null }]), TypeError);
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
    () => Reflect.apply(repo.bind, repo, [{ markdown: null, workspace: "here" }]),
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
    () => Reflect.apply(contract.amend, contract, [{ markdown: "## Append: Context\ntext\n", gates: ["invalid"] }]),
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
