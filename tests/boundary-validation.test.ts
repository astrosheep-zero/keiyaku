import { accepted } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Akumas, Debts, Kei, Keis, KeiyakuError, Repo, World } from "../src/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function invalidInput(error: unknown, message?: string): boolean {
  assert.ok(error instanceof KeiyakuError);
  assert.equal(error.category, "invalid-input");
  if (message !== undefined) assert.equal(error.message, message);
  return true;
}

test("Akumas.tell preserves schema refusal in caller field order", async () => {
  const repository = makeGitRepository();
  const akumas = Akumas.of(await World.at(repository.path));
  await assert.rejects(
    () => akumas.tell({ extra: true, schema: {} } as never),
    (error: unknown) => invalidInput(error, "Akumas.tell input has unknown field: extra"),
  );
  await assert.rejects(
    () => akumas.tell({ schema: {}, extra: true } as never),
    (error: unknown) => invalidInput(error, "Akumas.tell does not accept schema; use Akumas.ask"),
  );
});

test("Contract and Debt boundaries reject actor before reading product authority", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const contracts = Keis.of(repo);
  const contract = contracts.kei({ id: "kei/missing" as never });
  assert.throws(() => Keis.of(repo, { actor: "operator" } as never), /unknown field: actor/u);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => contracts.bind({ terms: "terms", actor: "operator" } as never)),
    /unknown field: actor/u,
  );
  for (const call of [
    () => contract.amend({ edits: "## Context\nChanged\n", actor: "operator" } as never),
    () => contract.arc({ body: "# Chapter", actor: "operator" } as never),
    () => contract.review({ verdict: "satisfied", summary: "ok", actor: "operator" } as never),
    () => contract.abandon({ actor: "operator" } as never),
  ]) {
    await assert.rejects(
      () => withGitShim("exit 99", {}, async () => { await call(); }),
      (error: unknown) => { invalidInput(error); assert.match((error as Error).message, /actor/u); return true; },
    );
  }
  const debts = Debts.of(await World.at(repository.path));
  assert.throws(() => debts.add({ title: "Unwritten", actor: "operator" } as never), /Unrecognized key.*actor/su);
  assert.throws(
    () => debts.addDocument({ markdown: "---\ntitle: Unwritten\n---\n", actor: "operator" } as never),
    /unknown field: actor/u,
  );
});

test("package boundary rejects malformed runtime inputs before journal mutation", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const before = (await Keis.of(repo).list({  })).rows;

  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Reflect.apply(Repo.at, Repo, [null])),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
  assert.throws(
    () => withGitShim("exit 99", {}, () => Keis.of(repo).kei({ id: null } as never)),
    (error: unknown) => invalidInput(error, "contract ID must be a string"),
  );
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Keis.of(repo).list(null as never)),
    (error: unknown) => invalidInput(error, "Keis.list input must be an object"),
  );
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Keis.of(repo).observe({ id: "bad" as never })),
    (error: unknown) => invalidInput(error, "contract ID must be kei/<contract-segment>"),
  );
  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () => Keis.of(repo).bind({ terms: null } as never)),
    invalidInput,
  );

  assert.deepEqual((await Keis.of(repo).list({  })).rows, before);
});

test("boundary validation precedes Git and unrepresentable targets stay typed", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const refused = await Keis.of(repo).bind({
      terms: [
        "# T",
        "",
        "## Context",
        "C",
        "",
        "## Objective",
        "O",
        "",
        "## Design",
        "D",
        "",
        "## Region",
        "~~~",
        "src/**",
        "~~~",
        "",
        "## Criteria",
        "### C",
        "C",
        "",
      ].join("\n"),
      target: "bad\0target",
    });
  assert.ok(refused.kind === "refused");
  assert.deepEqual(refused.reason, { kind: "invalid-target" });

  const bound = accepted(await Keis.of(repo).bind({
    terms: [
      "# T",
      "",
      "## Context",
      "C",
      "",
      "## Objective",
      "O",
      "",
      "## Design",
      "D",
      "",
      "## Region",
      "~~~",
      "src/**",
      "~~~",
      "",
      "## Criteria",
      "### C",
      "C",
      "",
    ].join("\n"),
    gates: ["reviewed"],
  }));
  assert.ok(bound.kei instanceof Kei);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => bound.kei.deliver({ actor: " " } as never)),
    (error: unknown) => invalidInput(error, "deliver input has unknown field: actor"),
  );
  await assert.rejects(
    () => bound.kei.review({ verdict: "satisfied", summary: "Boundary review", hooks: { create: [], destroy: [] } } as never),
    (error: unknown) => invalidInput(error, "review input has unknown field: hooks"),
  );
  await assert.rejects(
    () => bound.kei.previewDelivery({ requireBranchesToBeUpToDate: true } as never),
    (error: unknown) => invalidInput(error, "delivery preview input has unknown field: requireBranchesToBeUpToDate"),
  );
});
