import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, Repo } from "../src/index.js";
import { parseArgv } from "../src/cli/parse.js";
import { cliJson } from "./support/cli-fixtures.js";
import { GIT_REF } from "../src/git/repository.js";
import { document, repositoryWithMain, present, accepted } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";

test("fork bind copies the source target and does not substitute the caller branch", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  repository.run(["branch", "release"]);
  const source = accepted(await Keiyaku.with().bind({
    repo,
    markdown: document().replace("# Library verbs", "# Targeted source"),
    workspace: "worktree",
    target: "release",
    gates: [],
  }));
  const sourceState = present(await source.value.keiyaku.state());
  assert.equal(sourceState.coordinates.target, "refs/heads/release");

  repository.run(["checkout", "-B", "caller"]);
  const fork = accepted(await Keiyaku.with().bind({ repo, forkOf: sourceState.id }));
  const forkState = present(await fork.value.keiyaku.state());
  assert.equal(forkState.coordinates.target, "refs/heads/release");
  assert.equal(forkState.coordinates.start, sourceState.coordinates.start);
});

test("fork bind refuses missing sources and incompatible term inputs", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const missing = await Keiyaku.with().bind({ repo, forkOf: "kei/missing" as never });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") {
    assert.equal(missing.refusal.kind, "fork-source-missing");
    assert.equal(missing.refusal.contractId, "kei/missing");
  }
  await assert.rejects(
    () => Keiyaku.with().bind({ repo, forkOf: "kei/source" as never, gates: [] } as never),
    /Keiyaku.bind input has unknown field: gates/u,
  );
});

test("fork CLI reads no stdin and keeps its form disjoint", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const source = accepted(await Keiyaku.with().bind({
    repo,
    markdown: document().replace("# Library verbs", "# CLI source"),
    workspace: "worktree",
    gates: [],
  }));
  const sourceId = (present(await source.value.keiyaku.state())).id;
  const result = await cliJson<Readonly<{ kind: string; operation: string }>>(["bind", "--fork-of", sourceId], {
    cwd: repository.path,
    environment: {},
    readStdin: () => {
      throw new Error("fork bind must not read stdin");
    },
  });
  assert.equal(result.exit, 0);
  assert.equal(result.value.kind, "accepted");
  assert.equal(result.value.operation, "bind");
  assert.throws(() => parseArgv(["bind", "--fork-of", sourceId, "-"]), /fork bind reads no stdin/u);
  assert.throws(
    () => parseArgv(["bind", "--fork-of", sourceId, "--gates", "default"]),
    /not valid with --fork-of/u,
  );
  assert.throws(
    () => parseArgv(["bind", "--fork-of", sourceId, "--after", sourceId]),
    /not valid with --fork-of/u,
  );
  assert.throws(
    () => parseArgv(["bind", "--fork-of", sourceId, "--task", "task/example"]),
    /not valid with --fork-of/u,
  );
});

test("fork admission rejects a source amend interleaved at the state transaction", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const source = accepted(await Keiyaku.with().bind({
    repo,
    markdown: document().replace("# Library verbs", "# Race source"),
    workspace: "worktree",
    gates: [],
  }));
  const sourceState = present(await source.value.keiyaku.state());
  const oldState = repository.run(["rev-parse", GIT_REF]).trim();
  await source.value.keiyaku.amend({ gates: ["reviewed"] });
  const movedState = repository.run(["rev-parse", GIT_REF]).trim();
  repository.run(["update-ref", GIT_REF, oldState, movedState]);
  const marker = `${repository.path}/fork-race.marker`;
  const raced = await withGitShim(
      [
        'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_FORK_RACE_MARKER" ]; then',
        '  touch "$KEIYAKU_FORK_RACE_MARKER"',
        '  "$KEIYAKU_REAL_GIT" -C "$KEIYAKU_FORK_RACE_REPO" update-ref "$KEIYAKU_FORK_RACE_STATE_REF" "$KEIYAKU_FORK_RACE_MOVED" "$KEIYAKU_FORK_RACE_OLD"',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {
        KEIYAKU_FORK_RACE_MARKER: marker,
        KEIYAKU_FORK_RACE_REPO: repository.path,
        KEIYAKU_FORK_RACE_STATE_REF: GIT_REF,
        KEIYAKU_FORK_RACE_OLD: oldState,
        KEIYAKU_FORK_RACE_MOVED: movedState,
      },
      async (gitPath) =>
        Keiyaku.with().bind({ repo: await Repo.at({ path: repository.path, gitPath }), forkOf: sourceState.id }),
  );
  assert.equal(raced.kind, "refused");
  if (raced.kind === "refused") {
    assert.equal(raced.refusal.kind, "fork-source-moved");
    assert.equal(raced.refusal.contractId, sourceState.id);
  }
  assert.deepEqual((present(await source.value.keiyaku.state())).terms.gates, ["reviewed"]);
});
