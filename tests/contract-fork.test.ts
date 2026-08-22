import assert from "node:assert/strict";
import test from "node:test";
import { Keiyaku, KeiyakuRefused, Repo } from "../src/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";
import { withGitShim } from "./support/git.js";

test("fork bind copies current terms and the exact source start into fresh custody", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const prerequisite = await Keiyaku.bind({ repo, markdown: document().replace("# Library verbs", "# Prerequisite"), gates: [] });
  const sourceMarkdown = document().replace("# Library verbs", "# Source terms");
  const source = await Keiyaku.bind({
    repo, markdown: sourceMarkdown, workspace: "worktree", gates: ["reviewed"], after: [prerequisite.keiyaku.id],
  });
  const sourceState = await source.keiyaku.state();

  const fork = await Keiyaku.bind({ repo, forkOf: source.keiyaku.id });
  const forkState = await fork.keiyaku.state();

  assert.equal(forkState.terms.document.bytes, sourceMarkdown.replace("# Source terms", "# Fork · Source terms"));
  assert.equal(forkState.coordinates.start, sourceState.coordinates.start);
  assert.equal(forkState.coordinates.target, sourceState.coordinates.target);
  assert.equal(forkState.coordinates.workspace, "worktree");
  assert.deepEqual(forkState.terms.gates, sourceState.terms.gates);
  assert.deepEqual(forkState.terms.after, sourceState.terms.after);
  assert.notEqual(fork.keiyaku.id, source.keiyaku.id);
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
  const fork = await Keiyaku.bind({ repo, forkOf: source.keiyaku.id });
  const forkState = await fork.keiyaku.state();
  assert.equal(forkState.coordinates.target, "refs/heads/release");
  assert.equal(forkState.coordinates.start, sourceState.coordinates.start);
});

test("fork bind refuses missing sources and incompatible term inputs", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  await assert.rejects(
    () => Keiyaku.bind({ repo, forkOf: "kei/missing" as never }),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "fork-source-missing" && error.refusal.contractId === "kei/missing",
  );
  await assert.rejects(
    () => Keiyaku.bind({ repo, forkOf: "kei/source" as never, gates: [] } as never),
    /fork bind input has unknown field: gates/u,
  );
});

test("fork CLI reads no stdin and keeps its form disjoint", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const source = await Keiyaku.bind({ repo, markdown: document().replace("# Library verbs", "# CLI source"), workspace: "worktree", gates: [] });
  const result = await invoke(parseArgv(["bind", "--fork-of", source.keiyaku.id]), {
    cwd: repository.path,
    environment: {},
    readStdin: () => { throw new Error("fork bind must not read stdin"); },
  });
  assert.equal(result.kind, "accepted");
  assert.equal(result.verb, "bind");
  assert.throws(() => parseArgv(["bind", "--fork-of", source.keiyaku.id, "-"]), /fork bind reads no stdin/u);
  assert.throws(() => parseArgv(["bind", "--fork-of", source.keiyaku.id, "--gates", "default"]), /not valid with --fork-of/u);
  assert.throws(() => parseArgv(["bind", "--fork-of", source.keiyaku.id, "--after", source.keiyaku.id]), /not valid with --fork-of/u);
  assert.throws(() => parseArgv(["bind", "--fork-of", source.keiyaku.id, "--task", "task/example"]), /not valid with --fork-of/u);
});

test("fork admission rejects a source amend interleaved at the state transaction", async () => {
  const repository = repositoryWithMain();
  const repo = await Repo.at({ path: repository.path });
  const source = await Keiyaku.bind({ repo, markdown: document().replace("# Library verbs", "# Race source"), workspace: "worktree", gates: [] });
  const marker = `${repository.path}/fork-race.marker`;
  await assert.rejects(
    withGitShim(
      [
        'if [ "$1" = "update-ref" ] && [ ! -e "$KEIYAKU_FORK_RACE_MARKER" ]; then',
        '  touch "$KEIYAKU_FORK_RACE_MARKER"',
        '  node --import "$KEIYAKU_FORK_RACE_LOADER" --input-type=module -e \'const { Keiyaku, Repo } = await import(process.env.KEIYAKU_FORK_RACE_MODULE); await Keiyaku.of({ repo: await Repo.at({ path: process.env.KEIYAKU_FORK_RACE_REPO }), id: process.env.KEIYAKU_FORK_RACE_ID }).amend({ gates: [] });\'',
        "fi",
        'exec "$KEIYAKU_REAL_GIT" "$@"',
      ].join("\n"),
      {
        KEIYAKU_FORK_RACE_MARKER: marker,
        KEIYAKU_FORK_RACE_LOADER: new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href,
        KEIYAKU_FORK_RACE_MODULE: new URL("../src/index.ts", import.meta.url).href,
        KEIYAKU_FORK_RACE_REPO: repository.path,
        KEIYAKU_FORK_RACE_ID: source.keiyaku.id,
      },
      async (gitPath) => Keiyaku.bind({ repo: await Repo.at({ path: repository.path, gitPath }), forkOf: source.keiyaku.id }),
    ),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "fork-source-moved"
      && error.refusal.contractId === source.keiyaku.id,
  );
  assert.equal((await source.keiyaku.state()).terms.gates.length, 0);
});
