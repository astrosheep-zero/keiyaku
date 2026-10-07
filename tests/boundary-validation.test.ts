import { accepted } from "./support/library-verbs.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, KeiyakuError, Repo } from "../src/index.js";
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
  const before = (await Keiyaku.with().list({ repo })).rows;

  await assert.rejects(() => withGitShim("exit 99", {}, () => Reflect.apply(Repo.at, Repo, [null])), TypeError);
  assert.throws(
    () => withGitShim("exit 99", {}, () => Keiyaku.with().select({ repo, id: null } as never)),
    TypeError,
  );
  await assert.rejects(() => withGitShim("exit 99", {}, () => Keiyaku.with().list(null as never)), TypeError);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Keiyaku.with().observe({ repo, id: "bad" as never })),
    (error: unknown) => error instanceof TypeError && error.message === "contract ID must be kei/<contract-segment>",
  );
  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () => Keiyaku.with().bind({ repo, markdown: null, workspace: "worktree" } as never)),
    invalidInput,
  );

  assert.deepEqual((await Keiyaku.with().list({ repo })).rows, before);
});

test("amend validates programmer input before observing a missing contract", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.with().select({ repo, id: "kei/missing" as never });
  const before = (await Keiyaku.with().list({ repo })).rows;

  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () =>
        Reflect.apply(contract.amend, contract, [{ markdown: "## Append: Context\ntext\n", gates: ["Invalid"] }]),
      ),
    (error: unknown) => invalidInput(error, "gates[0] must match ^[a-z][a-z0-9-]{0,63}$"),
  );
  assert.deepEqual((await Keiyaku.with().list({ repo })).rows, before);
});

test("boundary validation precedes Git and unrepresentable targets stay typed", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const refused = await Keiyaku.with().bind({
      repo,
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

  const bound = accepted(await Keiyaku.with().bind({
    repo,
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
  assert.ok(bound.value.keiyaku instanceof Keiyaku);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => bound.value.keiyaku.deliver({ actor: " " } as never)),
    (error: unknown) => invalidInput(error, "deliver input has unknown field: actor"),
  );
  await assert.rejects(
    () => bound.value.keiyaku.review({ verdict: "satisfied", hooks: { create: [], destroy: [] } } as never),
    (error: unknown) => invalidInput(error, "review input has unknown field: hooks"),
  );
  await assert.rejects(
    () => bound.value.keiyaku.audit({ requireBranchesToBeUpToDate: true } as never),
    (error: unknown) => invalidInput(error, "audit input has unknown field: requireBranchesToBeUpToDate"),
  );
});
