import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo } from "../src/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

test("package boundary rejects malformed runtime inputs before journal mutation", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const before = (await Keiyaku.list({ repo })).rows;

  await assert.rejects(() => withGitShim("exit 99", {}, () => Reflect.apply(Repo.at, Repo, [null])), TypeError);
  assert.throws(
    () => withGitShim("exit 99", {}, () => Reflect.apply(Keiyaku.of, Keiyaku, [{ repo, id: null }])),
    TypeError,
  );
  await assert.rejects(() => withGitShim("exit 99", {}, () => Reflect.apply(Keiyaku.list, Keiyaku, [null])), TypeError);
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => Reflect.apply(Keiyaku.observe, Keiyaku, [{ repo, id: "bad" }])),
    (error: unknown) => error instanceof TypeError && error.message === "contract ID must be kei/<contract-segment>",
  );
  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () =>
        Reflect.apply(Keiyaku.bind, Keiyaku, [{ repo, markdown: null, workspace: "worktree" }]),
      ),
    TypeError,
  );

  assert.deepEqual((await Keiyaku.list({ repo })).rows, before);
});

test("amend validates programmer input before observing a missing contract", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  const contract = Keiyaku.of({ repo, id: "kei/missing" as never });
  const before = (await Keiyaku.list({ repo })).rows;

  await assert.rejects(
    () =>
      withGitShim("exit 99", {}, () =>
        Reflect.apply(contract.amend, contract, [{ markdown: "## Append: Context\ntext\n", gates: ["Invalid"] }]),
      ),
    (error: unknown) => error instanceof TypeError && error.message === "gates[0] must match ^[a-z][a-z0-9-]{0,63}$",
  );
  assert.deepEqual((await Keiyaku.list({ repo })).rows, before);
});

test("boundary validation precedes Git and unrepresentable targets stay typed", async () => {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Boundary Test"]);
  repository.run(["config", "user.email", "boundary@example.test"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const repo = await Repo.at({ path: repository.path });
  await assert.rejects(
    Keiyaku.bind({
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
    }),
    (error: unknown) => error instanceof KeiyakuRefused && error.code === "invalid-target",
  );

  const bound = await Keiyaku.bind({
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
    gates: ["security-audited"],
  });
  await assert.rejects(
    () => withGitShim("exit 99", {}, () => bound.keiyaku.deliver({ actor: " " } as never)),
    (error: unknown) => error instanceof TypeError && error.message === "deliver input has unknown field: actor",
  );
  await assert.rejects(
    () => bound.keiyaku.review({ verdict: "satisfied", hooks: { create: [], destroy: [] } } as never),
    (error: unknown) => error instanceof TypeError && error.message === "review input has unknown field: hooks",
  );
  await assert.rejects(
    () => bound.keiyaku.audit({ requireBranchesToBeUpToDate: true } as never),
    (error: unknown) => error instanceof TypeError && error.message === "audit input has unknown field: requireBranchesToBeUpToDate",
  );
});
