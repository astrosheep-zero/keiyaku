import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { AuthorityCorruptionError, Keiyaku, KeiyakuRefused, Repo } from "../src/index.js";
import { contractJournalPath } from "../src/git/identity.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import {
  GIT_REF,
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import {
  claimTaskHolderWithFence,
  finishTaskHolderAdmission,
  readTaskHoldersAt,
} from "../src/settlement/holder.js";
import { deliveryWorktreePath } from "../src/git/workspace.js";
import { readNamespaceContext } from "../src/task/context.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { makeGitRepository } from "./support/git.js";

function repository() {
  const value = makeGitRepository();
  value.run(["config", "user.name", "Test User"]);
  value.run(["config", "user.email", "test@example.com"]);
  value.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  value.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  writeFileSync(join(value.path, ".git", "info", "exclude"), ".keiyaku/locks/\n");
  return value;
}

function document(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "Exercise Contract-to-Task delivery composition.",
    "",
    "## Objective",
    "Keep completion inside reviewed delivery content.",
    "",
    "## Design",
    "Compose holder, Task bytes, and Git integration without runtime settlement writes.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Completion",
    "Claimed delivery contains canonical done Task authority.",
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

async function taskState(path: string, id: string) {
  const detail = await Tasks.of(await World.at(path)).task({ id }).read();
  assert.ok(detail);
  return detail.task;
}

function commitTasks(world: ReturnType<typeof repository>, message = "track Task authority"): void {
  world.run(["add", ".keiyaku/tasks"]);
  world.run(["commit", "--quiet", "-m", message]);
}

test("targetless delivery materializes held completion without mutating the Task checkout", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Targetless completion");
  commitTasks(world);
  const before = await taskState(world.path, taskId);
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("Targetless completion"), workspace: "here", gates: [] });
  const state = await bound.keiyaku.state();
  const git = repositoryAt(world.path);
  assert.equal(readGit(git).paths.has(contractJournalPath(state.id)), true);
  assert.deepEqual(await withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, readTaskHoldersAt)), [{
    version: 1,
    taskId,
    contractId: state.id,
    disposition: "held",
  }]);

  const delivered = await bound.keiyaku.deliver();
  const integrated = world.run(["show", `${delivered.value.integration.snapshot}:${taskPath(taskId)}`]);

  assert.match(integrated, /^state: done$/mu);
  assert.match(integrated, new RegExp(`^createdAt: ${before.createdAt}$`, "mu"));
  assert.match(integrated, new RegExp(`^updatedAt: ${before.updatedAt}$`, "mu"));
  assert.equal((await taskState(world.path, taskId)).state, "open");
  assert.deepEqual(delivered.settlement.actions, []);
  assert.deepEqual(delivered.settlement.lags, []);
  assert.equal(world.run(["status", "--porcelain"]), "");
});

test("targeted claim publishes implementation and done Task bytes together", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Atomic target completion");
  commitTasks(world);
  const before = await taskState(world.path, taskId);
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Atomic target completion"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: ["reviewed"],
  });
  const state = await bound.keiyaku.state();
  const worktree = deliveryWorktreePath(repositoryAt(world.path), state.id);
  const handle = Keiyaku.of({ repo: Repo.at({ path: worktree }), id: state.id });
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");

  const reviewed = await handle.review({ verdict: "satisfied", summary: "complete reviewed integration" });
  assert.equal(reviewed.value.placement?.refusal.kind, "delivery-missing");
  const claimed = await handle.deliver({ includeDirty: true });
  const after = await taskState(world.path, taskId);

  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(after.state, "done");
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.updatedAt, before.updatedAt);
  assert.equal(readFileSync(join(world.path, "candidate.txt"), "utf8"), "candidate\n");
  assert.deepEqual(claimed.settlement.actions, []);
  assert.deepEqual(claimed.settlement.lags, []);
  assert.equal(world.run(["status", "--porcelain"]), "");
  assert.equal(existsSync(worktree), false);
});

test("abandon releases the holder without reopening Task authority", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Abandoned Task", "done");
  commitTasks(world);
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("No reopen"), workspace: "here" });

  const abandoned = await bound.keiyaku.abandon();

  assert.equal((await taskState(world.path, taskId)).state, "done");
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

test("missing and terminal held Task authority refuse before delivery admission", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const missing = "task/missing" as const;
  const missingBound = await Keiyaku.bind({ repo, task: missing, markdown: document("Missing Task"), workspace: "here", gates: [] });
  await assert.rejects(
    () => missingBound.keiyaku.deliver(),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "task-completion-refused"
      && error.refusal.reason === "missing",
  );
  assert.equal((await missingBound.keiyaku.state()).delivery, null);
  await missingBound.keiyaku.abandon();

  const dropped = await task(world.path, "Dropped Task", "drop");
  commitTasks(world, "track dropped Task");
  const droppedBound = await Keiyaku.bind({ repo, task: dropped, markdown: document("Dropped Task"), workspace: "here", gates: [] });
  await assert.rejects(
    () => droppedBound.keiyaku.deliver(),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "task-completion-refused"
      && error.refusal.reason === "terminal",
  );
  assert.equal((await droppedBound.keiyaku.state()).delivery, null);
});

test("a held Task is exclusive until its Contract releases it", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const taskId = await task(world.path, "Exclusive holder");
  commitTasks(world);
  const first = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("First holder"),
    workspace: "worktree",
    target: "refs/heads/main",
    gates: [],
  });
  const firstState = await first.keiyaku.state();
  await assert.rejects(
    () => Keiyaku.bind({ repo, task: taskId, markdown: document("Second holder"), workspace: "worktree", gates: [] }),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "task-already-held"
      && error.refusal.taskId === taskId
      && error.refusal.holder === firstState.id,
  );

  const firstWorktree = deliveryWorktreePath(repositoryAt(world.path), firstState.id);
  const firstHandle = Keiyaku.of({ repo: Repo.at({ path: firstWorktree }), id: firstState.id });
  const delivered = await firstHandle.deliver();

  assert.equal((await first.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal((await taskState(world.path, taskId)).state, "done");
  assert.equal(delivered.value.integration.changeId.length > 0, true);
});

test("abandon rejects corrupt authority assigning one Contract multiple holders", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const firstTask = await task(world.path, "First holder");
  const secondTask = await task(world.path, "Second holder");
  const first = await Keiyaku.bind({ repo, task: firstTask, markdown: document("First holder"), workspace: "here" });
  await Keiyaku.bind({ repo, task: secondTask, markdown: document("Second holder"), workspace: "worktree" });
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

test("TaskHolder reads reject unexpected authority paths", async () => {
  const world = repository();
  await Keiyaku.bind({ repo: Repo.at({ path: world.path }), markdown: document("Initialize authority"), workspace: "here" });
  const git = repositoryAt(world.path);
  const snapshot = readGit(git);
  const tree = updateGitTree(git, snapshot.tree, new Map([
    ["settlement/task-holders", { oid: writeBlob(git, "not holder authority\n") }],
  ]));
  const commit = writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");

  await assert.rejects(
    withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, readTaskHoldersAt)),
    (error: unknown) => error instanceof AuthorityCorruptionError
      && error.message === "TaskHolder authority root is not a tree: settlement/task-holders",
  );
});

test("holder fence release failures preserve accepted admission", async () => {
  const accepted = { kind: "accepted" } as const;
  assert.deepEqual(
    finishTaskHolderAdmission("task/example" as const, accepted, () => { throw new Error("release failed"); }),
    {
      kind: "accepted-release-failed",
      result: accepted,
      taskId: "task/example",
      diagnostic: "release failed",
    },
  );
  assert.throws(
    () => finishTaskHolderAdmission("task/example" as const, { kind: "refused" } as const, () => { throw new Error("release failed"); }),
    /release failed/u,
  );
});

test("holder claim executes inside the Task settlement fence", async () => {
  const world = repository();
  const git = repositoryAt(world.path);
  let entered = false;
  const admission = await withGitDecodeChannel(git, (channel) => claimTaskHolderWithFence(git, channel, "task/fenced" as const, () => {
    entered = true;
    return { kind: "accepted" } as const;
  }));
  assert.equal(entered, true);
  assert.equal(admission.kind, "completed");
});

test("managed bind installs Task namespace after worktree materialization", async () => {
  const world = repository(), repo = Repo.at({ path: world.path });
  const bound = await Keiyaku.bind({ repo, markdown: document("Namespace settlement"), workspace: "worktree" });
  const action = bound.settlement.actions[0];
  assert.ok(action);
  const state = await bound.keiyaku.state();
  assert.deepEqual(readNamespaceContext(action.path), [state.id.slice("kei/".length)]);
  assert.equal(bound.effects.some((effect) => effect.kind === "namespace-context"), false);
});
