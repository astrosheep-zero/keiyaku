import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { captureWorkspaceTree } from "../src/git/workspace.js";
import { cachedRepositoryAt, type TestGitRepository } from "./support/git.js";
import { repositoryWithMain } from "./support/library-verbs.js";

function custody(repository: TestGitRepository, workspace = repository.path) {
  const index = repository.run(["-C", workspace, "rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const head = repository.run(["-C", workspace, "rev-parse", "HEAD"]).trim();
  return { index: readFileSync(index), head };
}

async function capturePreservingCustody(repository: TestGitRepository, workspace = repository.path) {
  const before = custody(repository, workspace);
  const captured = await captureWorkspaceTree(await cachedRepositoryAt(repository.path), workspace);
  assert.deepEqual(custody(repository, workspace), before);
  assert.equal(captured.head, before.head);
  return captured;
}

test("fresh capture takes final staged, unstaged, deleted and untracked bytes", async () => {
  const repository = repositoryWithMain({ files: { "tracked.txt": "base\n", "deleted.txt": "delete\n" } });
  writeFileSync(join(repository.path, "tracked.txt"), "staged\n");
  repository.run(["add", "tracked.txt"]);
  writeFileSync(join(repository.path, "tracked.txt"), "final\n");
  rmSync(join(repository.path, "deleted.txt"));
  writeFileSync(join(repository.path, "untracked.txt"), "new\n");

  const captured = await capturePreservingCustody(repository);

  assert.equal(captured.dirty, true);
  assert.equal(repository.run(["show", `${captured.tree}:tracked.txt`]), "final\n");
  assert.equal(repository.run(["show", `${captured.tree}:untracked.txt`]), "new\n");
  assert.equal(repository.run(["ls-tree", "--name-only", captured.tree]), "tracked.txt\nuntracked.txt\n");
});
