import { accepted, present } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Keis, Repo } from "../src/index.js";
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
  const result = accepted(await Keis.of(await Repo.at({ path: repository.path })).bind({
    markdown: document(title, region),
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
    markdown: ["## Replace: Region", "~~~", "src/api/internal/**", "~~~", ""].join("\n"),
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
      Keis.of(await Repo.at({ path: repository.path, gitPath })).bind({
        markdown: document("Observed failure", ["docs/**"]),
      }),
  );
  const receipt = accepted(result);
  const failure = receipt.issues?.find((issue) => issue.kind === "reconcile-failed");
  assert.equal(failure?.kind, "reconcile-failed");
  if (failure?.kind === "reconcile-failed") assert.match(failure.diagnostic, /git cat-file --batch/u);
  const state = present(await accepted(result).kei.state());
  assert.equal(state.id, receipt.contractId);
  assert.equal(state.terminal, null);
  const observed = await Keis.of(await Repo.at({ path: repository.path })).observe({ id: state.id });
  assert.equal(observed.kind, "present");
});
