import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

function repositoryWithHead(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function document(title: string, region: readonly string[]): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Observe the current Region.",
    "",
    "## Objective",
    "Expose non-authoritative overlap witnesses.",
    "",
    "## Design",
    "Read all live documents from one snapshot.",
    "",
    "## Region",
    "~~~",
    ...region,
    "~~~",
    "",
    "## Criteria",
    "### C1",
    "The operation keeps its admission result.",
    "",
  ].join("\n");
}

async function bind(repository: TestGitRepository, title: string, region: readonly string[], workspace: "worktree" | "here" = "here") {
  const result = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
    markdown: document(title, region),
    workspace,
  });
  return result;
}

test("bind and amend expose only live-peer Region witnesses from one document read", async () => {
  const repository = repositoryWithHead();
  const first = await bind(repository, "First", ["src/**"]);
  const firstId = (await first.keiyaku.state()).id;

  const second = await bind(repository, "Second", ["src/api/**"], "worktree");
  const secondId = (await second.keiyaku.state()).id;
  assert.deepEqual(second.overlaps, [{
    contract: firstId,
    patterns: [{ mine: "src/api/**", theirs: "src/**" }],
  }]);
  assert.equal("overlapFailure" in second, false);

  await first.keiyaku.abandon();

  const third = await bind(repository, "Third", ["src/api/internal/**"]);
  const thirdId = (await third.keiyaku.state()).id;
  assert.deepEqual(third.overlaps, [{
    contract: secondId,
    patterns: [{ mine: "src/api/internal/**", theirs: "src/api/**" }],
  }]);

  const amended = await second.keiyaku.amend({ markdown: [
    "## Replace: Region",
    "~~~",
    "src/api/internal/**",
    "~~~",
    "",
  ].join("\n") });
  assert.deepEqual(amended.overlaps, [{
    contract: thirdId,
    patterns: [{ mine: "src/api/internal/**", theirs: "src/api/internal/**" }],
  }]);
  assert.equal("overlapFailure" in amended, false);
});

test("post-admission observation failure preserves the admitted Contract without abandonment", async () => {
  const repository = repositoryWithHead();
  await bind(repository, "Existing", ["src/**"]);
  const marker = `${repository.path}/region-observation-admitted`;
  const batchPid = `${repository.path}/region-observation-batch.pid`;
  const result = await withGitShim(
      [
        "if [ \"$1 $2\" = \"cat-file --batch\" ]; then",
        "  printf '%s\\n' \"$$\" > \"$KEIYAKU_REGION_BATCH_PID\"",
        "fi",
        "if [ \"$1\" = \"update-ref\" ] && [ ! -e \"$KEIYAKU_REGION_MARKER\" ]; then",
        "  \"$KEIYAKU_REAL_GIT\" \"$@\" || exit $?",
        "  kill -TERM \"$(cat \"$KEIYAKU_REGION_BATCH_PID\")\"",
        "  touch \"$KEIYAKU_REGION_MARKER\"",
        "  exit 0",
        "fi",
        "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
      ].join("\n"),
      { KEIYAKU_REGION_MARKER: marker, KEIYAKU_REGION_BATCH_PID: batchPid },
      () => Keiyaku.bind({ repo: Repo.at({ path: repository.path }),
        markdown: document("Observed failure", ["docs/**"]),
        workspace: "worktree",
      }),
  );
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bind"]);
  assert.notEqual(result.head, null);
  assert.equal(result.lags[0]?.kind, "reconcile-failed");
  if (result.lags[0]?.kind === "reconcile-failed") {
    assert.equal(result.lags[0].stage, "observation");
    assert.match(result.lags[0].diagnostic, /git cat-file --batch/u);
  }
  const state = await result.keiyaku.state();
  assert.equal(state.id, result.facts[0]?.contract);
  assert.equal(state.head, result.head);
  assert.equal(state.terminal, null);
  const observed = await Keiyaku.observe({ repo: Repo.at({ path: repository.path }), id: state.id });
  assert.equal(observed.kind, "present");
});
