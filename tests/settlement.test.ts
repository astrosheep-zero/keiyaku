import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, Keiyaku, Repo } from "../src/index.js";
import { contractJournalPath } from "../src/git/identity.js";
import {
  GIT_REF,
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { readTaskHolders } from "../src/settlement/holder.js";
import { settleAll } from "../src/settlement/settle.js";
import { readNamespaceContext } from "../src/task/context.js";
import { Tasks } from "../src/task/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";

function repository() {
  const value = makeGitRepository();
  value.run(["config", "user.name", "Test User"]);
  value.run(["config", "user.email", "test@example.com"]);
  value.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  value.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return value;
}

function document(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise cross-product settlement.",
    "",
    "## Objective",
    "Keep Contract and Task authority independent.",
    "",
    "## Design",
    "Project accepted facts through settlement.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Settlement",
    "The expected Task state is visible.",
  ].join("\n");
}

async function task(path: string, title: string, state: "open" | "done" = "open") {
  const result = await Tasks.at({ path }).add({ title, state });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("Task creation was not accepted");
  return result.value.id;
}

function replaceTaskState(path: string, id: string, before: string, after: string): void {
  const authority = `${path}/.keiyaku/tasks/${id.slice("task/".length)}.md`;
  const bytes = readFileSync(authority, "utf8");
  writeFileSync(authority, bytes.replace(`state: ${before}\n`, `state: ${after}\n`));
}

async function taskState(path: string, id: string) {
  const detail = await Tasks.at({ path }).task({ id }).read();
  assert.ok(detail);
  return detail.task.state;
}

test("accepted claim synchronously settles its current held Task", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Claimed Task");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Synchronous settlement"), workspace: "here", gates: [] });
  const state = await bound.keiyaku.state();
  const git = repositoryAt(world.path);
  assert.equal(readGit(git).paths.has(contractJournalPath(state.id)), true);
  assert.deepEqual(readTaskHolders(git), [{
    version: 1,
    taskId,
    contractId: state.id,
    disposition: "held",
  }]);
  writeFileSync(`${world.path}/candidate.txt`, "candidate\n");

  const delivered = await bound.keiyaku.deliver();

  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(delivered.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(delivered.settlement.lags, []);
});

test("accepted abandonment reopens its current released Task", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Abandoned Task", "done");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Reopen settlement"), workspace: "here" });

  const abandoned = await bound.keiyaku.abandon();

  assert.equal(await taskState(world.path, taskId), "open");
  assert.deepEqual(abandoned.settlement.actions, [{ kind: "task", taskId, action: "reopened" }]);
  assert.deepEqual(abandoned.settlement.lags, []);
});

test("contract and world reconcile replay settlement from current authority", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const firstTask = await task(world.path, "Contract Replay Task");
  const first = await Keiyaku.bind({ repo, task: firstTask, markdown: document("Contract replay"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/first.txt`, "first\n");
  await first.keiyaku.deliver();
  replaceTaskState(world.path, firstTask, "done", "open");

  const local = await first.keiyaku.reconcile();
  assert.deepEqual(local.settlement.actions, [{ kind: "task", taskId: firstTask, action: "done" }]);

  const secondTask = await task(world.path, "World Replay Task");
  const second = await Keiyaku.bind({ repo, task: secondTask, markdown: document("World replay"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/second.txt`, "second\n");
  await second.keiyaku.deliver();
  const secondId = (await second.keiyaku.state()).id;
  replaceTaskState(world.path, secondTask, "done", "open");

  const report = await repo.reconcile();
  const settled = report.contracts.find((item) => item.contractId === secondId);
  assert.deepEqual(settled?.report.settlement.actions, [{ kind: "task", taskId: secondTask, action: "done" }]);
  assert.equal(await taskState(world.path, secondTask), "done");
});

test("batch settlement reads one holder projection for multiple Contracts", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const firstTask = await task(world.path, "First batch holder");
  const secondTask = await task(world.path, "Second batch holder");
  const first = await Keiyaku.bind({ repo, task: firstTask, markdown: document("First batch"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/first-batch.txt`, "first\n");
  await first.keiyaku.deliver();
  const second = await Keiyaku.bind({ repo, task: secondTask, markdown: document("Second batch"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/second-batch.txt`, "second\n");
  await second.keiyaku.deliver();
  const log = join(world.path, "holder-reads.log");
  const states = await Promise.all([first.keiyaku.state(), second.keiyaku.state()]);

  const reports = await withGitShim(
    'printf "%s\\n" "$*" >> "$KEIYAKU_READ_LOG"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_READ_LOG: log },
    () => settleAll({
      repository: repositoryAt(world.path),
      contracts: [
        { state: states[0]!, effects: [] },
        { state: states[1]!, effects: [] },
      ],
    }),
  );

  assert.equal(reports.length, 2);
  const fullTreeReads = readFileSync(log, "utf8").trim().split("\n")
    .filter((command) => {
      const args = command.split(" ");
      return args.includes("ls-tree") && args.includes("-z") && args.includes("-r")
        && args.includes("--full-tree") && !args.includes("--");
    });
  assert.equal(fullTreeReads.length, 1);
});

test("a superseded Contract cannot release or settle a newer holder", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Superseded Holder");
  const first = await Keiyaku.bind({ repo, task: taskId, markdown: document("Old holder"), workspace: "here" });
  const second = await Keiyaku.bind({ repo, task: taskId, markdown: document("Current holder"), workspace: "here", gates: [] });

  const abandoned = await first.keiyaku.abandon();
  assert.deepEqual(abandoned.settlement.actions, []);
  assert.equal(await taskState(world.path, taskId), "open");

  writeFileSync(`${world.path}/current.txt`, "current\n");
  const claimed = await second.keiyaku.deliver();
  assert.deepEqual(claimed.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.equal(await taskState(world.path, taskId), "done");
});

test("abandon refuses corrupted authority that assigns one Contract multiple TaskHolders", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const firstTask = await task(world.path, "First holder");
  const secondTask = await task(world.path, "Second holder");
  const first = await Keiyaku.bind({ repo, task: firstTask, markdown: document("First holder"), workspace: "here" });
  await Keiyaku.bind({ repo, task: secondTask, markdown: document("Second holder"), workspace: "here" });
  const firstId = (await first.keiyaku.state()).id;
  const git = repositoryAt(world.path);
  const snapshot = readGit(git);
  const secondPath = `settlement/task-holders/${createHash("sha256").update(secondTask).digest("hex")}.json`;
  const duplicate = Buffer.from(`${JSON.stringify({
    version: 1,
    taskId: secondTask,
    contractId: firstId,
    disposition: "held",
  })}\n`);
  const tree = updateGitTree(git, snapshot.tree, new Map([[secondPath, { oid: writeBlob(git, duplicate) }]]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");

  await assert.rejects(
    () => first.keiyaku.abandon(),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === `Contract has multiple current TaskHolders: ${firstId}`,
  );
  assert.equal((await first.keiyaku.state()).terminal, null);
});

test("TaskHolder reads reject unexpected paths in their authority namespace", async () => {
  const world = repository();
  await Keiyaku.bind({ repo: Repo.at({ path: world.path }), markdown: document("Initialize authority"), workspace: "here" });
  const git = repositoryAt(world.path);
  const snapshot = readGit(git);
  const tree = updateGitTree(git, snapshot.tree, new Map([
    ["settlement/task-holders", { oid: writeBlob(git, "not holder authority\n") }],
  ]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");

  assert.throws(
    () => readTaskHolders(git),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === "TaskHolder authority root is not a tree: settlement/task-holders",
  );
});

test("a missing holder target remains an explicit Task settlement lag", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const missing = "task/missing" as const;
  const bound = await Keiyaku.bind({ repo, task: missing, markdown: document("Missing holder target"), workspace: "here", gates: [] });
  writeFileSync(`${world.path}/missing.txt`, "missing\n");
  const claimed = await bound.keiyaku.deliver();
  assert.equal(claimed.settlement.lags.length, 1);
  assert.deepEqual(claimed.settlement.lags[0], {
    kind: "settlement-failed",
    surface: "task",
    contractId: (await bound.keiyaku.state()).id,
    taskId: missing,
    diagnostic: `Task settlement refused: ${JSON.stringify({ kind: "task-missing", taskId: missing })}`,
  });
});

test("managed bind installs Task namespace only after worktree materialization", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const bound = await Keiyaku.bind({ repo, markdown: document("Namespace settlement"), workspace: "worktree" });
  const action = bound.settlement.actions.find((item) => item.kind === "namespace-context");
  assert.ok(action && action.kind === "namespace-context");
  const state = await bound.keiyaku.state();
  assert.deepEqual(readNamespaceContext(action.path), [state.id.slice("kei/".length)]);
  assert.equal(bound.effects.some((effect) => effect.kind === "namespace-context"), false);
});
