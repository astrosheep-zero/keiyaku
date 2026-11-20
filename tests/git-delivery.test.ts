import { accepted, present, repositoryWithMain } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { prepareDelivery } from "../src/protocol/deliver.js";
import { Keis, Repo } from "../src/index.js";
import { appointedWorktreePath, cachedRepositoryAt } from "./support/git.js";

function contractBody(): string {
  return contractMarkdown("Delivery patch identity", {
    Context: "Exercise Git-backed delivery preparation.",
    Objective: "Keep patch-content identity independent of commit identity.",
    Design: "Prepare a targetless delivery from the current worktree.",
    Region: "~~~\nsrc/git/**\n~~~",
    Criteria: "### Patch identity\nEqual patch bytes have one ChangeId.",
  });
}

test("targeted integration refuses unrelated histories without invoking merge-tree", async () => {
  const repository = repositoryWithMain({ files: { "shared.txt": "base\n" } });
  const bound = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: contractBody(),
      target: "refs/heads/main",
    }),
  );
  const state = present(await bound.kei.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(repository.path), state.id);
  repository.run(["-C", worktree, "checkout", "--orphan", "unrelated"]);
  repository.run(["-C", worktree, "rm", "--quiet", "-rf", "."]);
  writeFileSync(join(worktree, "unrelated.txt"), "unrelated\n");
  repository.run(["-C", worktree, "add", "unrelated.txt"]);
  repository.run(["-C", worktree, "commit", "--quiet", "-m", "unrelated"]);
  const targetHead = repository.run(["rev-parse", "refs/heads/main"]).trim();
  const prepared = await prepareDelivery(
    await cachedRepositoryAt(repository.path),
    { contractId: state.id, coordinates: state.coordinates },
    {
      title: "Unrelated delivery",
      document: contractBody(),
      requireBranchesToBeUpToDate: false,
    },
  );
  assert.deepEqual(prepared, {
    kind: "refused",
    refusal: {
      kind: "integration-failed",
      reason: "unrelated-histories",
      targetHead,
    },
  });
});
