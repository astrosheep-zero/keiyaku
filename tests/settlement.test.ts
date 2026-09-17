import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { privateStatePublicationSeatPath } from "../src/git/private-state-seat.js";
import { withGitDecodeChannel, withGitReadObservation } from "../src/git/read-observation.js";
import {
  GIT_REF,
  readGit,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { AuthorityCorruptionError, Keiyaku, type Keiyaku as KeiyakuHandle } from "../src/index.js";
import { readTaskHoldersAt } from "../src/settlement/holder.js";
import { settle } from "../src/settlement/settle.js";
import { contractMarkdown } from "./support/markdown.js";

type AcceptedDelivery = Exclude<
  Awaited<ReturnType<KeiyakuHandle["deliver"]>>,
  { kind: "integration-conflict-materialized" }
>;

function acceptedDelivery(result: Awaited<ReturnType<KeiyakuHandle["deliver"]>>): AcceptedDelivery {
  if (result.kind === "integration-conflict-materialized") {
    throw new Error(`unexpected integration conflict: ${result.conflictPaths.join(",")}`);
  }
  return result;
}

import { readNamespaceContext } from "../src/task/context.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import {
  appointedWorktreePath,
  cachedRepoAt,
  cachedRepositoryAt,
  makeGitRepository,
  withGitShim,
} from "./support/git.js";

function repository() {
  const value = makeGitRepository();
  value.run(["config", "user.name", "Test User"]);
  value.run(["config", "user.email", "test@example.com"]);
  value.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  writeFileSync(join(value.path, ".git", "info", "exclude"), ".keiyaku/locks/\n");
  return value;
}

function document(title: string): string {
  return contractMarkdown(title, {
    Context: "Exercise Contract-to-Task settlement.",
    Objective: "Keep Contract and Task authority independent.",
    Design: "Project accepted facts through settlement.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: "### Settlement\nThe expected Task state is visible.",
  });
}

async function task(path: string, title: string, state: "open" | "done" | "drop" = "open") {
  const result = await Tasks.of(await World.at(path)).add({ title, state });
  assert.ok(result.kind === "accepted", 'expected result.kind = "accepted"');
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
  const detail = await Tasks.of(await World.at(path))
    .task({ id })
    .read();
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

test("placement keeps post-bind Task edits and changes only state to done", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Edited completion");
  commitTasks(world);
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Edited completion"),
    workspace: "worktree",
    gates: [],
  });
  const authority = join(world.path, taskPath(taskId));
  const before = readFileSync(authority, "utf8");
  writeFileSync(authority, `${before}Manual edit after bind.\n`);
  writeFileSync(`${world.path}/edited.txt`, "edited\n");

  const delivered = acceptedDelivery(await bound.keiyaku.deliver({ includeDirty: true }));

  const after = readFileSync(authority, "utf8");
  assert.match(after, /Manual edit after bind\./u);
  assert.match(after, /^state: done$/mu);
  assert.match(after, new RegExp(`^createdAt: ${before.match(/createdAt: (.+)$/mu)![1]}$`, "mu"));
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(delivered.settlementLags, []);
  const replay = await bound.keiyaku.reconcile();
  assert.deepEqual(replay.settlement.actions, []);
  assert.deepEqual(replay.settlement.lags, []);
  assert.equal(readFileSync(authority, "utf8"), after);
});

test("reconcile replay of an owed completion is an idempotent no-op the second time", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Replay completion", "drop");
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Replay completion"),
    workspace: "worktree",
    gates: [],
  });
  writeFileSync(`${world.path}/replay.txt`, "replay\n");
  const delivered = acceptedDelivery(await bound.keiyaku.deliver({ includeDirty: true }));

  assert.equal(delivered.settlementLags[0]?.surface, "task");
  assert.equal((await bound.keiyaku.state()).terminal?.kind, "claimed");
  assert.equal(await taskState(world.path, taskId), "drop");
  assert.deepEqual(await holders(world), [
    { version: 1, taskId, contractId: (await bound.keiyaku.state()).id, disposition: "held" },
  ]);
  replaceTaskState(world.path, taskId, "drop", "open");

  const first = await bound.keiyaku.reconcile();
  assert.deepEqual(first.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(first.settlement.lags, []);
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(await holders(world), [
    { version: 1, taskId, contractId: (await bound.keiyaku.state()).id, disposition: "released" },
  ]);

  const second = await bound.keiyaku.reconcile();
  assert.deepEqual(second.settlement.actions, []);
  assert.deepEqual(second.settlement.lags, []);
  assert.equal(await taskState(world.path, taskId), "done");
});

test(
  "settlement reports committed Task cleanup failure before releasing its holder",
  { concurrency: false },
  async () => {
    const world = repository(),
      repo = await cachedRepoAt(world.path);
    const taskId = await task(world.path, "Settlement cleanup", "drop");
    const bound = await Keiyaku.bind({
      repo,
      task: taskId,
      markdown: document("Settlement cleanup"),
      workspace: "worktree",
      gates: [],
    });
    writeFileSync(join(world.path, "cleanup.txt"), "cleanup\n");
    const delivered = acceptedDelivery(await bound.keiyaku.deliver({ includeDirty: true }));
    assert.equal(delivered.settlementLags[0]?.surface, "task");
    assert.deepEqual(await holders(world), [
      { version: 1, taskId, contractId: (await bound.keiyaku.state()).id, disposition: "held" },
    ]);
    replaceTaskState(world.path, taskId, "drop", "open");
    assert.equal(await taskState(world.path, taskId), "open");

    const originalClose = DatabaseSync.prototype.close;
    let fail = true;
    DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
      try {
        if (
          fail &&
          (this.location() ?? "").includes(
            `${join(".keiyaku", "locks", "task")}${process.platform === "win32" ? "\\" : "/"}`,
          )
        ) {
          fail = false;
          throw new Error("task lock release failed");
        }
      } finally {
        originalClose.call(this);
      }
    };
    try {
      const replayed = await bound.keiyaku.reconcile();
      const state = await bound.keiyaku.state();
      assert.deepEqual(replayed.settlement.actions, [{ kind: "task", taskId, action: "done" }]);
      assert.deepEqual(replayed.settlement.lags, [
        {
          kind: "settlement-failed",
          surface: "task",
          contractId: state.id,
          taskId,
          diagnostic: "cannot release SQLite lock: task lock release failed",
        },
      ]);
      assert.equal(await taskState(world.path, taskId), "done");
      assert.deepEqual(await holders(world), [{ version: 1, taskId, contractId: state.id, disposition: "released" }]);
    } finally {
      DatabaseSync.prototype.close = originalClose;
    }
  },
);

test("abandon releases the holder without reopening Task authority", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Abandoned Task", "done");
  commitTasks(world);
  const bound = await Keiyaku.bind({ repo, task: taskId, markdown: document("No reopen"), workspace: "worktree" });

  const abandoned = await bound.keiyaku.abandon();

  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(abandoned.settlementLags, []);

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

test("a missing holder target remains an explicit Task settlement lag", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const missing = "task/missing" as const;
  const bound = await Keiyaku.bind({
    repo,
    task: missing,
    markdown: document("Missing holder target"),
    workspace: "worktree",
    gates: [],
  });
  writeFileSync(`${world.path}/missing.txt`, "missing\n");
  const claimed = acceptedDelivery(await bound.keiyaku.deliver({ includeDirty: true }));
  assert.equal(claimed.settlementLags.length, 1);
  assert.deepEqual(claimed.settlementLags[0], {
    kind: "settlement-failed",
    surface: "task",
    contractId: (await bound.keiyaku.state()).id,
    taskId: missing,
    diagnostic: `Task settlement refused: ${JSON.stringify({ kind: "task-missing", taskId: missing })}`,
  });
});

test("Settlement exact-read-backs an unknown TaskHolder release after external state advancement", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Unknown holder release", "drop");
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Unknown holder release"),
    workspace: "worktree",
    gates: [],
  });
  writeFileSync(`${world.path}/unknown-holder.txt`, "candidate\n");
  const delivered = acceptedDelivery(await bound.keiyaku.deliver({ includeDirty: true }));
  assert.equal(delivered.settlementLags[0]?.surface, "task");
  assert.deepEqual(await holders(world), [
    { version: 1, taskId, contractId: (await bound.keiyaku.state()).id, disposition: "held" },
  ]);
  replaceTaskState(world.path, taskId, "drop", "open");
  assert.equal(await taskState(world.path, taskId), "open");
  const state = await bound.keiyaku.state();

  const git = await cachedRepositoryAt(world.path);
  const held = await acquireSqliteTransactionLock({ path: privateStatePublicationSeatPath(git), mode: "immediate" });
  let resolveArrival: () => void = () => undefined;
  const arrival = new Promise<void>((resolve) => {
    resolveArrival = resolve;
  });
  const pending = withGitShim(
    [
      'if [ "$1" = "update-ref" ]; then',
      '  "$KEIYAKU_REAL_GIT" "$@" || exit $?',
      '  current=$("$KEIYAKU_REAL_GIT" rev-parse refs/heads/keiyaku-state)',
      '  tree=$("$KEIYAKU_REAL_GIT" rev-parse "$current^{tree}")',
      '  next=$("$KEIYAKU_REAL_GIT" commit-tree "$tree" -p "$current" -m external)',
      '  "$KEIYAKU_REAL_GIT" update-ref refs/heads/keiyaku-state "$next" "$current" || exit $?',
      "  kill -TERM $$",
      "fi",
      'exec "$KEIYAKU_REAL_GIT" "$@"',
    ].join("\n"),
    {},
    async (gitPath) => {
      const git = {
        ...(await cachedRepositoryAt(world.path, gitPath)),
        onPrivateStateSeatContention: resolveArrival,
      };
      return await withGitDecodeChannel(git, async (channel) =>
        settle({ repository: git, channel, state, effects: [] }),
      );
    },
  );
  await arrival;
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(await holders(world), [{ version: 1, taskId, contractId: state.id, disposition: "held" }]);
  held.close();
  const report = await pending;

  assert.deepEqual(report.actions, [{ kind: "task", taskId, action: "done" }]);
  assert.deepEqual(report.lags, []);
  assert.equal(await taskState(world.path, taskId), "done");
  assert.deepEqual(await holders(world), [{ version: 1, taskId, contractId: state.id, disposition: "released" }]);
});

test("abandon rejects corrupt authority assigning one Contract multiple holders", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const firstTask = await task(world.path, "First holder");
  const secondTask = await task(world.path, "Second holder");
  const first = await Keiyaku.bind({
    repo,
    task: firstTask,
    markdown: document("First holder"),
    workspace: "worktree",
  });
  await Keiyaku.bind({ repo, task: secondTask, markdown: document("Second holder"), workspace: "worktree" });
  const firstId = (await first.keiyaku.state()).id;
  const git = await cachedRepositoryAt(world.path);
  const snapshot = await readGit(git);
  const secondPath = `settlement/task-holders/${createHash("sha256").update(secondTask).digest("hex")}.json`;
  const duplicate = Buffer.from(
    `${JSON.stringify({
      version: 1,
      taskId: secondTask,
      contractId: firstId,
      disposition: "held",
    })}\n`,
  );
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([[secondPath, { oid: await writeBlob(git, duplicate) }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );

  await assert.rejects(
    () => first.keiyaku.abandon(),
    (error: unknown) =>
      error instanceof AuthorityCorruptionError &&
      error.message === `Contract has multiple current TaskHolders: ${firstId}`,
  );
  assert.equal((await first.keiyaku.state()).terminal, null);
});

test("TaskHolder reads reject unexpected authority paths", async () => {
  const world = repository();
  await Keiyaku.bind({
    repo: await cachedRepoAt(world.path),
    markdown: document("Initialize authority"),
    workspace: "worktree",
  });
  const git = await cachedRepositoryAt(world.path);
  const snapshot = await readGit(git);
  const tree = await updateGitTree(
    git,
    snapshot.tree,
    new Map([["settlement/task-holders", { oid: await writeBlob(git, "not holder authority\n") }]]),
  );
  const commit = await writeCommit({ repository: git, tree, parent: snapshot.commit });
  assert.equal(
    (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
    "published",
  );

  await assert.rejects(
    withGitDecodeChannel(git, (channel) => withGitReadObservation(git, channel, readTaskHoldersAt)),
    (error: unknown) =>
      error instanceof AuthorityCorruptionError &&
      error.message === "TaskHolder authority root is not a tree: settlement/task-holders",
  );
});

test("an active managed-worktree projection repairs malformed namespace context", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Namespace repair holder");
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Namespace repair holder"),
    workspace: "worktree",
    gates: [],
  });
  const state = await bound.keiyaku.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(world.path), state.id);
  mkdirSync(join(path, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(join(path, ".keiyaku", "namespace", "current"), "malformed\ncontext\n");
  const repaired = await bound.keiyaku.reconcile();

  assert.deepEqual(repaired.lag, []);
  assert.equal(existsSync(path), true);
  assert.deepEqual(await readNamespaceContext({ directory: path, boundary: path }), [
    "kei",
    state.id.slice("kei/".length),
  ]);
});

test("an active namespace projection failure remains a workspace lag", async () => {
  const world = repository(),
    repo = await cachedRepoAt(world.path);
  const taskId = await task(world.path, "Projection lag");
  const bound = await Keiyaku.bind({
    repo,
    task: taskId,
    markdown: document("Projection lag"),
    workspace: "worktree",
    gates: [],
  });
  const state = await bound.keiyaku.state();
  const path = await appointedWorktreePath(await cachedRepositoryAt(world.path), state.id);
  rmSync(join(path, ".keiyaku"), { recursive: true, force: true });
  writeFileSync(join(path, ".keiyaku"), "not a directory\n");

  const report = await bound.keiyaku.reconcile();

  assert.equal(report.lag.length, 1);
  assert.equal(report.lag[0]?.kind, "contract-file-failed");
  assert.equal(report.lag[0]?.path, join(path, ".keiyaku", "namespace", "current"));
  assert.equal((await bound.keiyaku.state()).terminal, null);
  assert.deepEqual(await holders(world), [{ version: 1, taskId, contractId: state.id, disposition: "held" }]);
});
