import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { makeGitRepository, type TestGitRepository } from "./support/git.js";

function repositoryWithHead(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function document(title: string, region: readonly string[]): string {
  return contractMarkdown(title, {
    Context: "Observe the current Region.",
    Objective: "Expose non-authoritative overlap witnesses.",
    Design: "Read all live documents from one snapshot.",
    Region: ["~~~", ...region, "~~~"].join("\n"),
    Criteria: "### C1\nThe operation keeps its admission result.\n",
  });
}

async function bind(repository: TestGitRepository, title: string, region: readonly string[]) {
  const result = accepted(
    await Keis.of(await Repo.at({ path: repository.path })).bind({
      terms: document(title, region),
    }),
  );
  return { result, id: present(await result.kei.state()).id };
}

test("bind exposes only live-peer Region witnesses from one document read", async () => {
  const repository = repositoryWithHead();
  const first = await bind(repository, "First", ["src/**"]);
  const second = await bind(repository, "Second", ["src/api/**"]);

  assert.deepEqual(second.result.overlaps, [
    {
      contractId: first.id,
      patterns: [{ mine: "src/api/**", theirs: "src/**", relation: "mine-within-theirs" }],
    },
  ]);
  assert.equal(second.result.overlapError, undefined);
});
