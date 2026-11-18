import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
import { runCli } from "./support/cli-fixtures.js";
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
  const result = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    terms: document(title, region),
  }));
  return result;
}

test("bind and amend expose only live-peer Region witnesses from one document read", async () => {
  const repository = repositoryWithHead();
  const first = await bind(repository, "First", ["src/**"]);
  const firstId = (present(await first.kei.state())).id;

  const second = await bind(repository, "Second", ["src/api/**"]);
  const secondId = (present(await second.kei.state())).id;
  assert.deepEqual(accepted(second).overlaps, [
    {
      contractId: firstId,
      patterns: [{ mine: "src/api/**", theirs: "src/**", relation: "mine-within-theirs" }],
    },
  ]);
  assert.equal(second.overlapError, undefined);

  await first.kei.abandon();

  const third = await bind(repository, "Third", ["src/api/internal/**"]);
  const thirdId = (present(await third.kei.state())).id;
  assert.deepEqual(accepted(third).overlaps, [
    {
      contractId: secondId,
      patterns: [{ mine: "src/api/internal/**", theirs: "src/api/**", relation: "mine-within-theirs" }],
    },
  ]);

  const amended = await second.kei.amend({
    edits: ["## Replace: Region", "~~~", "src/api/internal/**", "~~~", ""].join("\n"),
  });
  assert.deepEqual(accepted(amended).overlaps, [
    {
      contractId: thirdId,
      patterns: [{ mine: "src/api/internal/**", theirs: "src/api/internal/**" }],
    },
  ]);
  assert.equal(accepted(amended).overlapError, undefined);
});

test("region names a terminal Contract instead of reporting it missing", async () => {
  const repository = repositoryWithHead();
  const bound = await bind(repository, "Terminal region", ["src/**"]);
  const id = (present(await bound.kei.state())).id;
  await bound.kei.abandon();
  const result = await runCli(["-C", repository.path, "region", id], { cwd: repository.path });
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /reason  terminal/u);
  assert.doesNotMatch(result.stdout, /contract missing/u);
});
