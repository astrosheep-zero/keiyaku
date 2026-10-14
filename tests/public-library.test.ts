import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

/**
 * The package-root bind surface owns the one omitted-target default: the current branch of the
 * caller's explicit Repo worktree coordinate, with `null` as the deliberate targetless spelling.
 * The CLI edge's own literal flags are witnessed separately in tests/cli-bind-target.test.ts.
 */
test("public Keiyaku.bind omitted target names the Repo worktree branch", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });

  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), workspace: "worktree", gates: [] }));
  const state = present(await bound.value.keiyaku.state());
  assert.equal(state.coordinates.target, "refs/heads/main");

  await assert.rejects(
    () =>
      Keiyaku.with().bind({
        repo,
        markdown: document(),
        targetSelection: { kind: "current-branch" },
      } as never),
    /Keiyaku.bind input has unknown field: targetSelection/u,
  );
});

test("public Keiyaku.bind target:null stays targetless and a string target stays literal", async () => {
  const raw = repositoryWithMain();
  raw.run(["branch", "release"]);
  const repo = await Repo.at({ path: raw.path });

  const targetless = accepted(
    await Keiyaku.with().bind({ repo, markdown: document(), workspace: "worktree", target: null, gates: [] }),
  );
  assert.equal(present(await targetless.value.keiyaku.state()).coordinates.target, undefined);

  const explicit = accepted(
    await Keiyaku.with().bind({
      repo,
      markdown: document(),
      workspace: "worktree",
      target: "release",
      gates: [],
    }),
  );
  assert.equal(present(await explicit.value.keiyaku.state()).coordinates.target, "refs/heads/release");

  await assert.rejects(
    () => Keiyaku.with().bind({ repo, markdown: document(), workspace: "worktree", target: 7 } as never),
    /target must be a string or null/u,
  );
});

test("Repo.at rejects an absent or relative worktree coordinate before any filesystem work", async () => {
  await assert.rejects(() => Repo.at(undefined as never), /Repo\.at input must be an object/u);
  await assert.rejects(() => Repo.at({} as never), /repository path must be a nonblank string/u);
  await assert.rejects(() => Repo.at({ path: "relative/worktree" }), /repository path must be absolute/u);
});
