import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import type { AcceptedResult } from "../src/cli/result.js";
import { GIT_REF } from "../src/git/repository.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";

test("fork bind copies current terms and the exact source start into fresh custody", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const prerequisite = await Keiyaku.bind({
    repo,
    markdown: document().replace("# Library verbs", "# Prerequisite"),
    gates: [],
  });
  const prerequisiteState = await prerequisite.keiyaku.state();
  const sourceMarkdown = document().replace("# Library verbs", "# Source terms");
  const source = await Keiyaku.bind({
    repo,
    markdown: sourceMarkdown,
    workspace: "worktree",
    gates: ["reviewed"],
    after: [prerequisiteState.id],
  });
  const sourceState = await source.keiyaku.state();
  const sourceId = sourceState.id;

  const fork = await Keiyaku.bind({ repo, forkOf: sourceId });
  const forkState = await fork.keiyaku.state();

  assert.equal(forkState.terms.document.bytes, sourceMarkdown.replace("# Source terms", "# Fork · Source terms"));
  assert.equal(forkState.coordinates.start, sourceState.coordinates.start);
  assert.equal(forkState.coordinates.target, sourceState.coordinates.target);
  assert.equal(forkState.coordinates.workspace, "worktree");
  assert.deepEqual(forkState.terms.gates, sourceState.terms.gates);
  assert.deepEqual(forkState.terms.after, sourceState.terms.after);
  assert.notEqual(forkState.id, sourceId);
  assert.equal(forkState.delivery, null);
  assert.equal(forkState.terminal, null);

  await source.keiyaku.amend({ gates: [] });
  assert.deepEqual((await fork.keiyaku.state()).terms.gates, ["reviewed"]);
});

test("fork bind copies the source target and does not substitute the caller branch", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  repository.run(["branch", "release"]);
  const source = await Keiyaku.bind({
    repo,
    markdown: document().replace("# Library verbs", "# Targeted source"),
    workspace: "worktree",
    target: "release",
    gates: [],
  });
  const sourceState = await source.keiyaku.state();
  assert.equal(sourceState.coordinates.target, "refs/heads/release");

  repository.run(["checkout", "-B", "caller"]);
  const fork = await Keiyaku.bind({ repo, forkOf: sourceState.id });
  const forkState = await fork.keiyaku.state();
  assert.equal(forkState.coordinates.target, "refs/heads/release");
  assert.equal(forkState.coordinates.start, sourceState.coordinates.start);
});

test("fork bind refuses missing sources and incompatible term inputs", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  await assert.rejects(
    () => Keiyaku.bind({ repo, forkOf: "kei/missing" as never }),
    (error: unknown) =>
      error instanceof KeiyakuRefused &&
      error.refusal.kind === "fork-source-missing" &&
      error.refusal.contractId === "kei/missing",
  );
  await assert.rejects(
    () => Keiyaku.bind({ repo, forkOf: "kei/source" as never, gates: [] } as never),
    /fork bind input has unknown field: gates/u,
  );
});

test("fork CLI reads no stdin and keeps its form disjoint", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const source = await Keiyaku.bind({
    repo,
    markdown: document().replace("# Library verbs", "# CLI source"),
    workspace: "worktree",
    gates: [],
  });
  const sourceId = (await source.keiyaku.state()).id;
  const parsed = parseArgv(["bind", "--fork-of", sourceId]);
  if ("help" in parsed) throw new Error("fork bind parsed as help");
  const result = await invoke(parsed, {
    cwd: repository.path,
    environment: {},
    readStdin: () => {
      throw new Error("fork bind must not read stdin");
    },
  });
  assert.equal("kind" in result ? result.kind : undefined, "accepted");
  if (!("kind" in result) || result.kind !== "accepted" || !("verb" in result) || result.verb !== "bind") {
    throw new Error("fork bind did not return an accepted result");
  }
  assert.equal((result as Extract<AcceptedResult, { verb: "bind" }>).verb, "bind");
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
  const source = await Keiyaku.bind({
    repo,
    markdown: document().replace("# Library verbs", "# Race source"),
    workspace: "worktree",
    gates: [],
  });
  const sourceState = await source.keiyaku.state();
  const oldState = repository.run(["rev-parse", GIT_REF]).trim();
  await source.keiyaku.amend({ gates: ["reviewed"] });
  const movedState = repository.run(["rev-parse", GIT_REF]).trim();
  repository.run(["update-ref", GIT_REF, oldState, movedState]);
  const marker = `${repository.path}/fork-race.marker`;
  await assert.rejects(
    withGitShim(
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
        Keiyaku.bind({ repo: await Repo.at({ path: repository.path, gitPath }), forkOf: sourceState.id }),
    ),
    (error: unknown) =>
      error instanceof KeiyakuRefused &&
      error.refusal.kind === "fork-source-moved" &&
      error.refusal.contractId === sourceState.id,
  );
  assert.deepEqual((await source.keiyaku.state()).terms.gates, ["reviewed"]);
});
