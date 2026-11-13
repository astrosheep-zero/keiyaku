import { accepted } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Debts, Kei, Keis, KeiyakuError, Repo, World } from "../src/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function invalidInput(error: unknown, message?: string): boolean {
  assert.ok(error instanceof KeiyakuError);
  assert.equal(error.category, "invalid-input");
  if (message !== undefined) assert.equal(error.message, message);
  return true;
}

test("Contract and Debt boundaries reject actor before reading product authority", async () => {
  const repository = makeGitRepository();
  const repo = await Repo.at({ path: repository.path });
  const contracts = Keis.of(repo);
  const contract = contracts.kei({ id: "kei/missing" as never });
  assert.throws(() => Keis.of(repo, { actor: "operator" } as never), /unknown field: actor/u);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => contracts.bind({ markdown: "terms", actor: "operator" } as never)),
    /unknown field: actor/u,
  );
  for (const call of [
    () => contract.amend({ markdown: "## Context\nChanged\n", actor: "operator" } as never),
    () => contract.arc({ markdown: "# Chapter", actor: "operator" } as never),
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
      withGitShim("exit 99", {}, () => Keis.of(repo).bind({ markdown: null } as never)),
    invalidInput,
  );

  assert.deepEqual((await Keis.of(repo).list({  })).rows, before);
});

test("amend validates programmer input before observing a missing contract", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keis.of(repo).kei({ id: "kei/missing" as never });
  const before = (await Keis.of(repo).list({  })).rows;

  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () =>
        Reflect.apply(contract.amend, contract, [{ markdown: "## Append: Context\ntext\n", gates: ["Invalid"] }]),
      ),
    (error: unknown) => invalidInput(error, "gates[0] must match ^[a-z][a-z0-9-]{0,63}$"),
  );
  assert.deepEqual((await Keis.of(repo).list({  })).rows, before);
});

test("review rejects missing or blank summary before repository execution", async () => {
  const repository = makeGitRepository();
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keis.of(repo).kei({ id: "kei/missing" as never });
  let observations = 0;
  for (const input of [{ verdict: "satisfied" }, { verdict: "satisfied", summary: " \t\n" }]) {
    await assert.rejects(
      () => withGitShim("exit 99", {}, () => contract.review(input as never, { observe: () => { observations++; } })),
      invalidInput,
    );
  }
  assert.equal(observations, 0);
});

test("boundary validation precedes Git and unrepresentable targets stay typed", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const refused = await Keis.of(repo).bind({
      markdown: [
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
    markdown: [
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
