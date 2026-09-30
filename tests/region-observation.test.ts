import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { runCli } from "./support/cli-fixtures.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

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
  const result = accepted(await Keiyaku.with().bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(title, region),
    workspace: "worktree",
  }));
  return result;
}

test("bind warns about a whitespace Region pattern and still admits the Contract", async () => {
  const repository = repositoryWithHead();
  const bound = await bind(repository, "Whitespace", ["src/a b", "docs/**"]);
  assert.deepEqual(accepted(bound).value.warnings, ["Region pattern 'src/a b' contains whitespace and will never match a path"]);
  assert.deepEqual(
    bound.facts.map((fact) => fact.kind),
    ["bind"],
  );
  assert.notEqual(bound.head, null);
});

test("bind and amend expose only live-peer Region witnesses from one document read", async () => {
  const repository = repositoryWithHead();
  const first = await bind(repository, "First", ["src/**"]);
  const firstId = (present(await first.value.keiyaku.state())).id;

  const second = await bind(repository, "Second", ["src/api/**"]);
  const secondId = (present(await second.value.keiyaku.state())).id;
  assert.deepEqual(accepted(second).value.overlaps, [
    {
      contract: firstId,
      patterns: [{ mine: "src/api/**", theirs: "src/**", relation: "mine-within-theirs" }],
    },
  ]);
  assert.equal("overlapFailure" in second, false);

  await first.value.keiyaku.abandon();

  const third = await bind(repository, "Third", ["src/api/internal/**"]);
  const thirdId = (present(await third.value.keiyaku.state())).id;
  assert.deepEqual(accepted(third).value.overlaps, [
    {
      contract: secondId,
      patterns: [{ mine: "src/api/internal/**", theirs: "src/api/**", relation: "mine-within-theirs" }],
    },
  ]);

  const amended = await second.value.keiyaku.amend({
    markdown: ["## Replace: Region", "~~~", "src/api/internal/**", "~~~", ""].join("\n"),
  });
  assert.deepEqual(accepted(amended).value.overlaps, [
    {
      contract: thirdId,
      patterns: [{ mine: "src/api/internal/**", theirs: "src/api/internal/**", relation: "same" }],
    },
  ]);
  assert.equal("overlapFailure" in amended, false);
});

test("region names a terminal Contract instead of reporting it missing", async () => {
  const repository = repositoryWithHead();
  const bound = await bind(repository, "Terminal region", ["src/**"]);
  const id = (present(await bound.value.keiyaku.state())).id;
  await bound.value.keiyaku.abandon();
  const result = await runCli(["-C", repository.path, "region", id], { cwd: repository.path });
  assert.equal(result.exit, 1);
  assert.match(result.stdout, /reason  terminal/u);
  assert.doesNotMatch(result.stdout, /contract missing/u);
});


test("post-admission observation failure preserves the admitted Contract without abandonment", async () => {
  const repository = repositoryWithHead();
  await bind(repository, "Existing", ["src/**"]);
  const marker = `${repository.path}/region-observation-admitted`;
  const batchPid = `${repository.path}/region-observation-batch.pid`;
  const result = await withGitShim(
    [
      'if [ "$1 $2" = "cat-file --batch" ]; then',
      '  printf \'%s\\n\' "$$" > "$KEIYAKU_REGION_BATCH_PID"',
      "fi",
      'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_REGION_MARKER" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  kill -TERM "$(cat "$KEIYAKU_REGION_BATCH_PID")"',
      '  touch "$KEIYAKU_REGION_MARKER"',
      "  exit 0",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    { KEIYAKU_REGION_MARKER: marker, KEIYAKU_REGION_BATCH_PID: batchPid },
    async (gitPath) =>
      Keiyaku.with().bind({
        repo: await Repo.at({ path: repository.path, gitPath }),
        markdown: document("Observed failure", ["docs/**"]),
        workspace: "worktree",
      }),
  );
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["bind"],
  );
  assert.notEqual(accepted(result).head, null);
  assert.equal(result.effects.filter((effect) => effect.kind === "reconciliation-lag").map((effect) => effect.lag)[0]?.kind, "reconcile-failed");
  const lag = result.effects.filter((effect) => effect.kind === "reconciliation-lag").map((effect) => effect.lag)[0];
  if (lag?.kind === "reconcile-failed") {
    assert.equal(lag.stage, "observation");
    assert.match(lag.diagnostic, /git cat-file --batch/u);
  }
  const state = present(await accepted(result).value.keiyaku.state());
  assert.equal(state.id, result.facts[0]?.contract);
  assert.equal(state.head, accepted(result).head);
  assert.equal(state.terminal, null);
  const observed = await Keiyaku.with().observe({ repo: await Repo.at({ path: repository.path }), id: state.id });
  assert.equal(observed.kind, "present");
});
