import { accepted } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Kei, Keis, KeiyakuError, Repo } from "../src/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function invalidInput(error: unknown, message?: string): boolean {
  assert.ok(error instanceof KeiyakuError);
  assert.equal(error.category, "invalid-input");
  assert.ok(error.cause instanceof TypeError);
  if (message !== undefined) assert.equal(error.cause.message, message);
  return true;
}

test("package boundary rejects malformed runtime inputs before journal mutation", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const before = (await Keis.of(repo).list({  })).rows;

  await assert.rejects(() => withGitShim("exit 99", {}, () => Reflect.apply(Repo.at, Repo, [null])), TypeError);
  assert.throws(
    () => withGitShim("exit 99", {}, () => Keis.of(repo).kei({ id: null } as never)),
    TypeError,
  );
  await assert.rejects(() => withGitShim("exit 99", {}, () => Keis.of(repo).list(null as never)), TypeError);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Keis.of(repo).observe({ id: "bad" as never })),
    (error: unknown) => error instanceof TypeError && error.message === "contract ID must be kei/<contract-segment>",
  );
  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () => Keis.of(repo).bind({ markdown: null, workspace: "worktree" } as never)),
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
      workspace: "worktree",
    });
  assert.ok(refused.kind === "refused");
  assert.deepEqual(refused.refusal, { kind: "invalid-target" });

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
    workspace: "worktree",
    gates: ["reviewed"],
  }));
  assert.ok(bound.value.kei instanceof Kei);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => bound.value.kei.deliver({ actor: " " } as never)),
    (error: unknown) => invalidInput(error, "deliver input has unknown field: actor"),
  );
  await assert.rejects(
    () => bound.value.kei.review({ verdict: "satisfied", summary: "Boundary review", hooks: { create: [], destroy: [] } } as never),
    (error: unknown) => invalidInput(error, "review input has unknown field: hooks"),
  );
  await assert.rejects(
    () => bound.value.kei.previewDelivery({ requireBranchesToBeUpToDate: true } as never),
    (error: unknown) => invalidInput(error, "delivery preview input has unknown field: requireBranchesToBeUpToDate"),
  );
});
