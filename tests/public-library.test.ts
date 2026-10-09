import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { accepted, document, present, repositoryWithMain } from "./support/library-verbs.js";

/**
 * The package-root bind surface owns its own omitted-target mapping and never carries the CLI's
 * internal target-selection intent. The CLI edge's current-branch default is witnessed separately
 * in tests/cli-bind-target.test.ts.
 */
test("public Keiyaku.bind omitted target stays targetless and exposes no target-selection option", async () => {
  const raw = repositoryWithMain();
  const repo = await Repo.at({ path: raw.path });

  const bound = accepted(await Keiyaku.with().bind({ repo, markdown: document(), workspace: "worktree", gates: [] }));
  const state = present(await bound.value.keiyaku.state());
  assert.equal(state.coordinates.target, undefined);

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
