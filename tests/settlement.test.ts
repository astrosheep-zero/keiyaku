import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, Keiyaku, Repo } from "../src/index.js";
import { contractJournalPath } from "../src/git/identity.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import {
  GIT_REF,
  readGit,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import {
  finishTaskHolderAdmission,
  readTaskHoldersAt,
} from "../src/settlement/holder.js";
import { completeHolderMutation } from "../src/library/mutation.js";
import { EMPTY_WORKTREE_HOOKS } from "../src/library/configuration.js";
import { requireAccepted } from "../src/library/refusal.js";
import { reviewOperation } from "../src/protocol/review.js";
import { settle } from "../src/settlement/settle.js";

import { readNamespaceContext } from "../src/task/context.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { appointedWorktreePath, cachedRepoAt, cachedRepositoryAt, makeGitRepository } from "./support/git.js";

function repository() {
  const value = makeGitRepository();
  value.run(["config", "user.name", "Test User"]);
  value.run(["config", "user.email", "test@example.com"]);
  value.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  writeFileSync(join(value.path, ".git", "info", "exclude"), ".keiyaku/locks/\n");
  return value;
}

function document(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise Contract-to-Task settlement.",
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

async function task(path: string, title: string, state: "open" | "done" | "drop" = "open") {
  const result = await Tasks.of(await World.at(path)).add({ title, state });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("Task creation was not accepted");
  return result.value.id;
}

function taskPath(id: string): string {
  return `.keiyaku/tasks/${id.slice("task/".length)}.md`;
}

function replaceTaskState(path: string, id: string, before: string, after: string): void {
  const authority = `${path}/.keiyaku/tasks/${id.slice("task/".length)}.md`;
  const bytes = readFileSync(authority, "utf8");
  writeFileSync(authority, bytes.replace(`state: ${before}\n`, `state: ${after}\n`));
}

async function taskState(path: string, id: string) {
  const detail = await Tasks.of(await World.at(path)).task({ id }).read();
  assert.ok(detail);
  return detail.task.state;
}

async function holders(world: ReturnType<typeof repository>) {
  const git = await cachedRepositoryAt(world.path);
  return withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, readTaskHoldersAt));
}

function commitTasks(world: ReturnType<typeof repository>, message = "track Task authority"): void {
  world.run(["add", ".keiyaku/tasks"]);
  world.run(["commit", "--quiet", "-m", message]);
}

test("a Task document untracked in Git still completes through delivery", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Untracked completion");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Untracked completion"), workspace: "worktree", gates: [] });
  const state = await bound.keiyaku.state();
  const git = await cachedRepositoryAt(world.path);
  assert.equal((await readGit(git)).paths.has(contractJournalPath(state.id)), true);
  assert.deepEqual(await holders(world), [{
    version: 1,
    taskId,
    contractId: state.id,
    disposition: "held",
  }]);
  writeFileSync(`${world.path}/untracked.txt`, "untracked\n");

  const delivered = await bound.keiyaku.deliver({ includeDirty: true });

  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(delivered.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(delivered.settlement.lags, []);
  assert.deepEqual(await holders(world), [{
    version: 1,
    taskId,
    contractId: state.id,
    disposition: "released",
  }]);
});

test("placement keeps post-bind Task edits and changes only state to done", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Edited completion");
  commitTasks(world);
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Edited completion"), workspace: "worktree", gates: [] });
  const authority = join(world.path, taskPath(taskId));
  const before = readFileSync(authority, "utf8");
  writeFileSync(authority, `${before}Manual edit after bind.\n`);
  writeFileSync(`${world.path}/edited.txt`, "edited\n");

  const delivered = await bound.keiyaku.deliver({ includeDirty: true });

  const after = readFileSync(authority, "utf8");
  assert.match(after, /Manual edit after bind\./u);
  assert.match(after, /^state: done$/mu);
  assert.match(after, new RegExp(`^createdAt: ${before.match(/createdAt: (.+)$/mu)![1]}$`, "mu"));
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(delivered.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(delivered.settlement.lags, []);
});

test("a held Task already done still delivers without refusal", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Already done", "done");
  commitTasks(world);
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Already done"), workspace: "worktree", gates: [] });
  const state = await bound.keiyaku.state();
  writeFileSync(`${world.path}/already.txt`, "already\n");

  const delivered = await bound.keiyaku.deliver({ includeDirty: true });

  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(delivered.settlement.actions, []);
  assert.deepEqual(delivered.settlement.lags, []);
  assert.deepEqual(await holders(world), [{
    version: 1,
    taskId,
    contractId: state.id,
    disposition: "released",
  }]);
});

test("reconcile replay of an owed completion is an idempotent no-op the second time", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Replay completion", "drop");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Replay completion"), workspace: "worktree", gates: [] });
  writeFileSync(`${world.path}/replay.txt`, "replay\n");
  const delivered = await bound.keiyaku.deliver({ includeDirty: true });

  assert.equal(delivered.settlement.lags[0]?.surface, "task");
  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(await taskState(world.path, taskId), "drop");
  replaceTaskState(world.path, taskId, "drop", "open");

  const first = await bound.keiyaku.reconcile();
  assert.deepEqual(first.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(first.settlement.lags, []);
  assert.equal(await taskState(world.path, taskId), "done");

  const second = await bound.keiyaku.reconcile();
  assert.deepEqual(second.settlement.actions, []);
  assert.deepEqual(second.settlement.lags, []);
  assert.equal(await taskState(world.path, taskId), "done");
});

test("abandon releases the holder without reopening Task authority", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Abandoned Task", "done");
  commitTasks(world);
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("No reopen"), workspace: "worktree" });

  const abandoned = await bound.keiyaku.abandon();

  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(abandoned.settlement.actions, []);
  assert.deepEqual(abandoned.settlement.lags, []);

  const rebound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Released holder"),
    workspace: "worktree",
    gates: [],
  });
  assert.equal((await rebound.keiyaku.state()).terminal, null);
  await rebound.keiyaku.abandon();
});

test("a superseded Contract cannot release or settle a newer holder", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Superseded Holder");
  const first = await Keiyaku.bind({ repo, task: taskId, markdown: document("Old holder"), workspace: "worktree" });
  const second = await Keiyaku.bind({ repo, task: taskId, markdown: document("Current holder"), workspace: "worktree", gates: [] });

  const abandoned = await first.keiyaku.abandon();
  assert.deepEqual(abandoned.settlement.actions, []);
  assert.equal(await taskState(world.path, taskId), "open");

  writeFileSync(`${world.path}/current.txt`, "current\n");
  const claimed = await second.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(claimed.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.equal(await taskState(world.path, taskId), "done");
});

test("a missing holder target remains an explicit Task settlement lag", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const missing = "task/missing" as const;
  const bound = await Keiyaku.bind({ repo, task: missing, markdown: document("Missing holder target"), workspace: "worktree", gates: [] });
  writeFileSync(`${world.path}/missing.txt`, "missing\n");
  const claimed = await bound.keiyaku.deliver({ includeDirty: true });
  assert.equal(claimed.settlement.lags.length, 1);
  assert.deepEqual(claimed.settlement.lags[0], {
    kind: "settlement-failed",
    surface: "task",
    contractId: (await bound.keiyaku.state()).id,
    taskId: missing,
    diagnostic: `Task settlement refused: ${JSON.stringify({ kind: "task-missing", taskId: missing })}`,
  });
});

test("abandon rejects corrupt authority assigning one Contract multiple holders", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const firstTask = await task(world.path, "First holder");
  const secondTask = await task(world.path, "Second holder");
  const first = await Keiyaku.bind({ repo, task: firstTask, markdown: document("First holder"), workspace: "worktree" });
  await Keiyaku.bind({ repo, task: secondTask, markdown: document("Second holder"), workspace: "worktree" });
  const firstId = (await first.keiyaku.state()).id;
  const git = await cachedRepositoryAt(world.path);
  const snapshot = await readGit(git);
  const secondPath = `settlement/task-holders/${createHash("sha256").update(secondTask).digest("hex")}.json`;
  const duplicate = Buffer.from(`${JSON.stringify({
    version: 1,
    taskId: secondTask,
    contractId: firstId,
    disposition: "held",
  })}\n`);
  const tree = await updateGitTree(git, snapshot.tree, new Map([[secondPath, { oid: await writeBlob(git, duplicate) }]]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");

  await assert.rejects(
    () => first.keiyaku.abandon(),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === `Contract has multiple current TaskHolders: ${firstId}`,
  );
  assert.equal((await first.keiyaku.state()).terminal, null);
});

test("settlement ignores an unrelated missing private-state subtree", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Subtree settlement", "drop");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Subtree settlement"), workspace: "worktree", gates: [] });
  writeFileSync(`${world.path}/subtree.txt`, "subtree\n");
  await bound.keiyaku.deliver({ includeDirty: true });
  replaceTaskState(world.path, taskId, "drop", "open");

  const git = await cachedRepositoryAt(world.path);
  const state = await bound.keiyaku.state();
  const snapshot = await readGit(git);
  const missingTree = world.run(["mktree"], "").trim();
  const tree = await updateGitTree(git, snapshot.tree, new Map([
    ["unrelated/broken", { oid: missingTree, mode: "040000", type: "tree" }],
  ]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");
  unlinkSync(join(git.commonDirectory, "objects", missingTree.slice(0, 2), missingTree.slice(2)));

  const report = await withGitDecodeChannel(git, (channel) => settle({ repository: git, channel, state, effects: [] }));

  assert.deepEqual(report.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(report.lags, []);
  assert.equal(await taskState(world.path, taskId), "done");
});

test("TaskHolder reads reject unexpected authority paths", async () => {
  const world = repository();
  await Keiyaku.bind({ repo: await cachedRepoAt(world.path), markdown: document("Initialize authority"), workspace: "worktree" });
  const git = await cachedRepositoryAt(world.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(git, snapshot.tree, new Map([
    ["settlement/task-holders", { oid: await writeBlob(git, "not holder authority\n") }],
  ]));
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");

  await assert.rejects(
    withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, readTaskHoldersAt)),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === "TaskHolder authority root is not a tree: settlement/task-holders",
  );
});

test("a terminal held Contract completes placement and Task settlement after its fence close fails", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Fence teardown completion");
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Fence teardown completion"),
    workspace: "worktree",
    target: "main",
    gates: ["reviewed"],
  });
  const state = await bound.keiyaku.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(world.path), state.id);
  const fromWorktree = Keiyaku.of({ repo: await Repo.at({ path }), id: state.id });
  writeFileSync(`${path}/terminal.txt`, "candidate\n");
  await fromWorktree.deliver({ includeDirty: true });

  const scope = await cachedRepositoryAt(world.path);
  const completed = await withGitDecodeChannel(scope, async (channel) => {
    const accepted = requireAccepted(await reviewOperation({
      scope,
      channel,
      contractId: state.id,
      verdict: "satisfied",
    }));
    const admission = finishTaskHolderAdmission(taskId, accepted, () => {
      throw new Error("fence close failed");
    });
    return completeHolderMutation({
      completion: {
        scope,
        channel,
        contractId: state.id,
        value: (review) => review,
        hooks: EMPTY_WORKTREE_HOOKS,
      },
      admission,
      requireAccepted,
    });
  });

  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.match(world.run(["ls-tree", "-r", "--name-only", "HEAD"]), /^terminal\.txt$/mu);
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(completed.settlement.lags, [{
    kind: "settlement-failed",
    surface: "task-holder",
    contractId: state.id,
    taskId,
    diagnostic: "fence close failed",
  }]);
});

test("settlement replays from the primary worktree when the invocation cwd is gone", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Dead cwd claim");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Dead cwd"), workspace: "worktree", gates: [] });
  writeFileSync(`${world.path}/candidate.txt`, "candidate\n");
  const delivered = await bound.keiyaku.deliver({ includeDirty: true });
  assert.deepEqual(delivered.settlement.lags, []);
  const state = await bound.keiyaku.state();
  assert.equal(state.terminal?.kind, "claimed");
  const git = await cachedRepositoryAt(world.path);
  const dead = { ...git, effectiveCwd: join(world.path, "gone") };
  const report = await withGitDecodeChannel(git, (channel) => settle({ repository: dead, channel, state, effects: [] }));
  assert.deepEqual(report.lags, []);
  assert.deepEqual(report.actions, []);
});

test("a claimed managed-worktree Contract settles its held Task after removal", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Managed claim");
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Managed claim"), workspace: "worktree", gates: [] });
  const state = await bound.keiyaku.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(world.path), state.id);
  const fromWorktree = Keiyaku.of({ repo: await Repo.at({ path }), id: state.id });
  writeFileSync(`${path}/candidate.txt`, "candidate\n");
  const claimed = await fromWorktree.deliver({ includeDirty: true });
  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.deepEqual(claimed.settlement.lags, []);
  assert.deepEqual(claimed.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.equal(await taskState(world.path, taskId), "done");
  assert.equal(existsSync(path), false);
});

test("managed bind installs Task namespace after worktree materialization", async () => {
  const world = repository(), repo = await cachedRepoAt(world.path);
  const bound = await Keiyaku.bind({ repo, markdown: document("Namespace settlement"), workspace: "worktree" });
  const action = bound.settlement.actions[0];
  assert.ok(action);
  if (action.kind !== "namespace-context") throw new Error("expected namespace context settlement");
  const state = await bound.keiyaku.state();
  assert.deepEqual(await readNamespaceContext({ directory: action.path, boundary: action.path }), [state.id.slice("kei/".length)]);
  assert.equal(bound.effects.some((effect) => effect.kind === "namespace-context"), false);
});
