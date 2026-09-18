import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  TaskAuthorityCorruptionError,
  Tasks,
  type TaskId,
  type TaskMutationResult,
  type TaskTreeNode,
} from "../src/task/index.js";
import {
  decodeTaskMutationRequest,
  executeTaskMutation,
  taskMutationRequestCommand,
  type TaskMutationBodyRequest,
} from "../src/task/mutation.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { parseTaskDocument, serializeTaskDocument, type TaskDocument } from "../src/task/document.js";
import { parseTaskId } from "../src/task/identity.js";
import { observeTaskDetails, settleTask } from "../src/task/operations.js";
import {
  authorityPath,
  nukeTaskAuthority,
  replaceAuthority,
  withTaskLocks
} from "../src/task/store.js";
import { World, type WorldRoot } from "../src/world.js";

type Assert<Condition extends true> = Condition;

export type TaskBodyWorldRequiresCanonicalMint = Assert<
  [TaskMutationBodyRequest["world"]] extends [WorldRoot] ? false : true
>;

async function world(): Promise<{ root: WorldRoot; tasks: ReturnType<typeof Tasks.of> }> {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-tasks-"));
  mkdirSync(join(root, ".keiyaku"));
  const worldRoot = await World.at(root);
  return {
    root: worldRoot,
    tasks: Tasks.of(worldRoot),
  };
}

async function lifecycle(
  task: ReturnType<ReturnType<typeof Tasks.of>["task"]>,
  verb: "start" | "stop" | "hold" | "resume" | "done",
): Promise<TaskMutationResult> {
  switch (verb) {
    case "start":
      return await task.start();
    case "stop":
      return await task.stop();
    case "hold":
      return await task.hold();
    case "resume":
      return await task.resume();
    case "done":
      return await task.done();
  }
}
function acceptedId(result: Awaited<ReturnType<ReturnType<typeof Tasks.of>["add"]>>): TaskId {
  assert.ok(result.kind === "accepted", "expected result.kind = \"accepted\"");
  return result.value.id;
}

test("note is replaceable authority and product timestamps advance only on change", async () => {
  const { tasks } = await world();
  const added = await tasks.add({ title: "Timestamped", note: "first" });
  assert.ok(added.kind === "accepted", "expected added.kind = \"accepted\"");
  assert.equal(added.value.note, "first");
  assert.equal(added.value.createdAt, added.value.updatedAt);
  assert.equal(new Date(added.value.createdAt).toISOString(), added.value.createdAt);

  const replaced = await tasks.task({ id: added.value.id }).update({ note: "second" });
  assert.ok(replaced.kind === "accepted", "expected replaced.kind = \"accepted\"");
  assert.equal(replaced.value.task.note, "second");
  assert.equal(replaced.value.task.createdAt, added.value.createdAt);
  assert.ok(replaced.value.task.updatedAt > added.value.updatedAt);
  assert.match(replaced.value.documentDiff, /-note: first/u);
  assert.match(replaced.value.documentDiff, /\+note: second/u);

  const unchanged = await tasks.task({ id: added.value.id }).update({ note: "second" });
  assert.ok(unchanged.kind === "accepted", "expected unchanged.kind = \"accepted\"");
  assert.equal(unchanged.value.documentDiff, "");
  assert.equal(unchanged.value.task.updatedAt, replaced.value.task.updatedAt);
});

test("ordinary mutations advance a non-later timestamp by one millisecond", async () => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Future timestamp" }));
  const before = await tasks.task({ id }).read();
  if (before === null) return;
  const future = "2099-01-01T00:00:00.000Z";
  writeFileSync(authorityPath(root, id), serializeTaskDocument({ ...before.task, updatedAt: future }));

  const updated = await tasks.task({ id }).update({ note: "changed" });
  assert.equal(updated.kind, "accepted");
  if (updated.kind === "accepted") {
    assert.equal(updated.value.task.updatedAt, "2099-01-01T00:00:00.001Z");
  }
});

test("done and drop replace note while preserving creation time", async () => {
  const { tasks } = await world();
  const one = acceptedId(await tasks.add({ title: "One", note: "old" }));
  const before = await tasks.task({ id: one }).read();
  const done = await tasks.task({ id: one }).done({ note: "finished" });
  assert.equal(done.kind, "accepted");
  if (done.kind === "accepted") {
    assert.equal(done.value.state, "done");
    assert.equal(done.value.note, "finished");
    assert.equal(done.value.createdAt, before?.task.createdAt);
    assert.ok(done.value.updatedAt > (before?.task.updatedAt ?? ""));
  }

  const two = acceptedId(await tasks.add({ title: "Two" })),
    three = acceptedId(await tasks.add({ title: "Three" }));
  const batch = await tasks.batch({ verb: "done", ids: [two, "task/missing", three], note: "completed" });
  assert.deepEqual(
    batch.items.map((item) => item.id),
    [two, "task/missing", three],
  );
  assert.deepEqual(
    batch.items.map((item) => item.outcome.kind),
    ["accepted", "refused", "accepted"],
  );
  assert.ok(
    batch.items
      .filter((item) => item.outcome.kind === "accepted")
      .every((item) => item.outcome.kind !== "accepted" || item.outcome.value.note === "completed"),
  );
  assert.equal((await tasks.task({ id: three }).read())?.task.state, "done");
  const dropped = await tasks.task({ id: two }).drop({ note: "cancelled" });
  assert.equal(dropped.kind, "refused");
  const afterRefusal = await tasks.task({ id: two }).read();
  assert.equal(afterRefusal?.task.state, "done");
  assert.equal(afterRefusal?.task.note, "completed");
  assert.throws(() => tasks.batch({ verb: "hold", ids: [two], note: "invalid" }), /valid only for done or drop/u);
});

test("batch start preserves order and continues after per-task refusals", async () => {
  const { tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "Batch start first" }));
  const alreadyDone = acceptedId(await tasks.add({ title: "Batch start done", state: "done" }));
  const third = acceptedId(await tasks.add({ title: "Batch start third" }));
  const result = await tasks.batch({ verb: "start", ids: [first, "task/missing", alreadyDone, third] });
  assert.deepEqual(
    result.items.map((item) => item.id),
    [first, "task/missing", alreadyDone, third],
  );
  assert.deepEqual(
    result.items.map((item) => item.outcome.kind),
    ["accepted", "refused", "refused", "accepted"],
  );
  assert.equal((await tasks.task({ id: first }).read())?.task.state, "in_progress");
  assert.equal((await tasks.task({ id: third }).read())?.task.state, "in_progress");
  assert.throws(() => tasks.batch({ verb: "start", ids: [] }), /at least one TaskId/u);
});

function nextTaskLockAttempt(t: TestContext): Promise<void> {
  const { promise: pending, resolve: observed } = promiseBarrier<void>();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    // Lock initialization occurs after the batch has captured its board.
    if (sql === "PRAGMA busy_timeout=0") observed();
    return exec.call(this, sql);
  });
  return pending;
}

test("batch lifecycle reads one board before locks and retries only a concurrently changed Task", async (t) => {
  const { root, tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "Batch snapshot first" }));
  const second = acceptedId(await tasks.add({ title: "Batch snapshot second" }));
  const firstLock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "task", `${parseTaskId(first).localId}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const lockAttempt = nextTaskLockAttempt(t);
  const pending = tasks.batch({ verb: "start", ids: [first, second] });
  try {
    await lockAttempt;
    writeFileSync(authorityPath(root, second), "changed after batch observation\n");
  } finally {
    firstLock.close();
  }

  const result = await pending;
  assert.deepEqual(
    result.items.map((item) => item.outcome.kind),
    ["accepted", "retry"],
  );
  assert.deepEqual(result.items[1]?.outcome, { kind: "retry", reason: "concurrent-modification" });
});

test("batch invalid refusal retries when the Task becomes valid before its lock", async (t) => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Batch stale invalid", state: "done" }));
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "task", `${parseTaskId(id).localId}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const lockAttempt = nextTaskLockAttempt(t);
  const pending = tasks.batch({ verb: "start", ids: [id] });
  try {
    await lockAttempt;
    const current = await tasks.task({ id }).read();
    assert.notEqual(current, null);
    if (current === null) return;
    writeFileSync(authorityPath(root, id), serializeTaskDocument({ ...current.task, state: "open" }));
  } finally {
    lock.close();
  }

  const result = await pending;
  assert.deepEqual(result.items[0]?.outcome, { kind: "retry", reason: "concurrent-modification" });
});

test("batch missing refusal retries when the Task is created before its lock", async (t) => {
  const { root, tasks } = await world();
  const id = "task/batch-stale-missing-0000" as TaskId;
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "task", "batch-stale-missing-0000.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  const lockAttempt = nextTaskLockAttempt(t);
  const pending = tasks.batch({ verb: "start", ids: [id] });
  try {
    await lockAttempt;
    const created = await tasks.add({ title: "Batch stale missing" });
    assert.ok(created.kind === "accepted", "expected created.kind = \"accepted\"");
    const source = authorityPath(root, created.value.id);
    const document = parseTaskDocument(readFileSync(source), parseTaskId(created.value.id));
    writeFileSync(authorityPath(root, id), serializeTaskDocument({ ...document, id }));
    unlinkSync(source);
  } finally {
    lock.close();
  }

  const result = await pending;
  assert.deepEqual(result.items[0]?.outcome, { kind: "retry", reason: "concurrent-modification" });
});

test("Task mutation mints raw World once while Tasks consumes its branded capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-tasks-forged-world-"));
  mkdirSync(join(root, ".keiyaku"));
  const canonical = await World.at(root);
  await assert.rejects(
    taskMutationRequestCommand("task.add", {
      task: async () => Promise.reject(new Error("raw World must not reach the Task executor")),
    }).execute(
      {
        world: `${canonical}/.` as WorldRoot,
        request: { action: "task.add", input: { title: "must not write", namespace: [] } },
      },
      {
        id: "00000000-0000-4000-8000-000000000001",
        admittedAt: "2026-08-18T00:00:00.000Z",
        requester: "aku/parent/00000001",
        signal: new AbortController().signal,
        admissionOpen: () => true,
      },
    ),
    /canonical physical directory/u,
  );
  assert.equal(existsSync(join(canonical, ".keiyaku", "tasks")), false);
  const tasks = Tasks.of(canonical);
  assert.equal(tasks.root, canonical);
  assert.equal((await tasks.add({ title: "branded capability" })).kind, "accepted");
});

test("appendBody supplies one missing LF boundary without duplicating caller delimiters", async () => {
  const { tasks } = await world();
  const plain = acceptedId(await tasks.add({ title: "Plain body", body: "first" }));
  const appended = await tasks.task({ id: plain }).update({ appendBody: "second" });
  assert.equal(appended.kind, "accepted");
  if (appended.kind === "accepted") assert.equal(appended.value.task.body, "first\nsecond");

  const leading = await tasks.task({ id: plain }).update({ appendBody: "\nthird" });
  assert.equal(leading.kind, "accepted");
  if (leading.kind === "accepted") assert.equal(leading.value.task.body, "first\nsecond\nthird");

  const terminated = acceptedId(await tasks.add({ title: "Terminated body", body: "first\n" }));
  const afterTerminated = await tasks.task({ id: terminated }).update({ appendBody: "second" });
  assert.equal(afterTerminated.kind, "accepted");
  if (afterTerminated.kind === "accepted") assert.equal(afterTerminated.value.task.body, "first\nsecond");
});

test("bounded Task query filters before limit and parent views recurse", async () => {
  const { tasks } = await world();
  const parent = acceptedId(await tasks.add({ title: "Area", priority: 3 }));
  const need = acceptedId(await tasks.add({ title: "Need", priority: 0, parent }));
  const ready = acceptedId(await tasks.add({ title: "Ready auth", priority: 1, parent }));
  const nested = acceptedId(await tasks.add({ title: "Nested", priority: 2, parent: ready, needs: [need] }));
  assert.equal((await tasks.task({ id: nested }).start()).kind, "accepted");

  const selected = await tasks.query({
    scope: "world",
    where: {
      kind: "and",
      terms: [
        { kind: "predicate", predicate: { field: "under", operator: "=", value: parent } },
        { kind: "predicate", predicate: { field: "priority", operator: "<=", value: 1 } },
      ],
    },
    limit: 1,
  });
  assert.equal(selected.kind, "accepted");
  if (selected.kind === "accepted") {
    assert.deepEqual(
      selected.value.rows.map((row) => row.id),
      [need],
    );
    assert.equal(selected.value.hasMore, true);
  }

  const descendants = await tasks.ready({ scope: "world", parent });
  assert.equal(descendants.kind, "accepted");
  if (descendants.kind === "accepted")
    assert.deepEqual(
      descendants.value.rows.map((row) => row.id),
      [need, ready],
    );
  const blocked = await tasks.blocked({ scope: "world", parent });
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind === "accepted")
    assert.deepEqual(
      blocked.value.rows.map((row) => row.id),
      [nested],
    );
  assert.deepEqual(await tasks.ready({ parent: "task/missing" }), {
    kind: "refused",
    refusal: { kind: "task-missing", taskId: "task/missing" },
  });
  assert.deepEqual(
    await tasks.query({
      where: { kind: "predicate", predicate: { field: "under", operator: "=", value: "task/missing" } },
    }),
    { kind: "refused", refusal: { kind: "task-missing", taskId: "task/missing" } },
  );
});

test("Task row views share the bounded-list contract and complete their graph judgment first", async () => {
  const { root, tasks } = await world();
  mkdirSync(join(root, ".keiyaku", "tasks"), { recursive: true });
  const document = (id: TaskId, needs: readonly TaskId[] = []): TaskDocument => ({
    id,
    title: id,
    body: "",
    note: "",
    state: "open",
    priority: 2,
    needs,
    parent: null,
    supersedes: [],
    relates: [],
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T00:00:00.000Z",
  });
  for (let index = 0; index < 51; index += 1) {
    const ready = `task/ready-${String(index).padStart(2, "0")}` as TaskId;
    const blocked = `task/blocked-${String(index).padStart(2, "0")}` as TaskId;
    writeFileSync(authorityPath(root as WorldRoot, ready), serializeTaskDocument(document(ready)));
    writeFileSync(
      authorityPath(root as WorldRoot, blocked),
      serializeTaskDocument(document(blocked, ["task/missing" as TaskId])),
    );
  }

  const views = [
    await tasks.list({ scope: "world", selection: "all" }),
    await tasks.ready({ scope: "world" }),
    await tasks.blocked({ scope: "world" }),
    await tasks.query({ scope: "world" }),
  ];
  for (const view of views) {
    assert.equal(view.kind, "accepted");
    if (view.kind !== "accepted") continue;
    assert.deepEqual(Object.keys(view.value).sort(), ["hasMore", "rows"]);
    assert.equal(view.value.rows.length, 50);
    assert.equal(view.value.hasMore, true);
  }
  const maximum = await tasks.list({ scope: "world", selection: "all", limit: 500 });
  assert.equal(maximum.kind, "accepted");
  if (maximum.kind === "accepted") {
    assert.equal(maximum.value.rows.length, 102);
    assert.equal(maximum.value.hasMore, false);
  }
  await assert.rejects(() => tasks.list({ scope: "world", limit: 501 }), /integer from 1 to 500/u);
});

test("targeted reads expose outbound relations only; board projections derive reverse edges", async () => {
  const { tasks } = await world();
  const blocker = acceptedId(await tasks.add({ title: "A" }));
  const blocked = acceptedId(await tasks.add({ title: "B", needs: [blocker] }));
  const other = acceptedId(await tasks.add({ title: "C" }));
  const relatedFrom = acceptedId(await tasks.add({ title: "D", relates: [blocker] }));

  const shown = await tasks.task({ id: blocker }).read();
  assert.deepEqual(
    shown?.blocks.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    shown?.children.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    shown?.supersededBy.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    shown?.related.map((item) => item.id),
    [],
  );
  const shownBlocked = await tasks.task({ id: blocked }).read();
  assert.deepEqual(
    shownBlocked?.needs.map((item) => item.id),
    [blocker],
  );
  assert.deepEqual(
    shownBlocked?.blocks.map((item) => item.id),
    [],
  );
  const shownRelatedFrom = await tasks.task({ id: relatedFrom }).read();
  assert.deepEqual(
    shownRelatedFrom?.related.map((item) => item.id),
    [blocker],
  );

  const detailed = await observeTaskDetails(tasks.root, [blocker, blocked]);
  assert.equal(detailed.kind, "accepted");
  if (detailed.kind === "accepted") {
    assert.deepEqual(
      detailed.value[0]?.blocks.map((item) => item.id),
      [],
    );
    assert.deepEqual(
      detailed.value[0]?.related.map((item) => item.id),
      [],
    );
    assert.deepEqual(
      detailed.value[1]?.needs.map((item) => item.id),
      [blocker],
    );
    assert.deepEqual(
      detailed.value[1]?.blocks.map((item) => item.id),
      [],
    );
  }

  const selectsBlocker = await tasks.query({
    scope: "world",
    where: { kind: "predicate", predicate: { field: "blocks", operator: "=", value: blocked } },
  });
  assert.equal(selectsBlocker.kind, "accepted");
  if (selectsBlocker.kind === "accepted") {
    assert.deepEqual(
      selectsBlocker.value.rows.map((row) => row.id),
      [blocker],
    );
    assert.deepEqual(
      selectsBlocker.value.rows[0]?.blocks.map((item) => item.id),
      [blocked],
    );
  }

  const doesNotSelectBlocked = await tasks.query({
    scope: "world",
    where: { kind: "predicate", predicate: { field: "blocks", operator: "=", value: blocker } },
  });
  assert.equal(doesNotSelectBlocked.kind, "accepted");
  if (doesNotSelectBlocked.kind === "accepted") {
    assert.deepEqual(
      doesNotSelectBlocked.value.rows.map((row) => row.id),
      [],
    );
  }

  const complement = await tasks.query({
    scope: "world",
    where: { kind: "predicate", predicate: { field: "blocks", operator: "!=", value: blocked } },
  });
  assert.equal(complement.kind, "accepted");
  if (complement.kind === "accepted") {
    assert.deepEqual(
      complement.value.rows.map((row) => row.id),
      [blocked, other, relatedFrom],
    );
  }
});

test("Task query defaults to active Tasks", async () => {
  const { tasks } = await world();
  const active = acceptedId(await tasks.add({ title: "Active" }));
  acceptedId(await tasks.add({ title: "Finished", state: "done" }));
  acceptedId(await tasks.add({ title: "Dropped", state: "drop" }));
  const result = await tasks.query();
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted")
    assert.deepEqual(
      result.value.rows.map((row) => row.id),
      [active],
    );
});

test("concurrent same-title creation allocates stable unique suffixes", async () => {
  const { tasks } = await world();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => tasks.add({ title: "Collision" })));
  assert.ok(outcomes.every((outcome) => outcome.kind === "accepted"));
  const ids = outcomes.flatMap((outcome) => (outcome.kind === "accepted" ? [outcome.value.id] : []));
  assert.equal(new Set(ids).size, 6);
  assert.ok(ids.every((id) => /^task\/collision-[0-9a-f]{4}$/u.test(id)));
});

test("relation mutation rejects only newly declared missing and self targets", async () => {
  const { tasks } = await world(),
    id = acceptedId(await tasks.add({ title: "Subject" }));
  const missing = await tasks.task({ id }).update({ needs: ["task/missing"] });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") assert.equal(missing.refusal.kind, "invalid-graph");
  const self = await tasks.task({ id }).update({ relates: [id] });
  assert.equal(self.kind, "refused");
  if (self.kind === "refused") assert.equal(self.refusal.kind, "invalid-graph");
});

test("existing graph disease does not adjudicate an unrelated relation addition", async () => {
  const { root, tasks } = await world();
  const subject = acceptedId(await tasks.add({ title: "Subject" }));
  const valid = acceptedId(await tasks.add({ title: "Valid target" }));
  const path = authorityPath(root, subject);
  const document = parseTaskDocument(readFileSync(path), parseTaskId(subject));
  writeFileSync(path, serializeTaskDocument({ ...document, needs: ["task/missing"] }));

  assert.equal((await tasks.task({ id: subject }).update({ addNeeds: [valid] })).kind, "accepted");
  assert.deepEqual((await tasks.doctor()).issues, [
    { kind: "missing-target", taskId: subject, relation: "needs", target: "task/missing" },
  ]);
});

test("reset re-resolves authority after a namespace swap while the task lock is held", async () => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Reset custody race", namespace: ["foo"] }));
  const lock = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "task", "foo", `${parseTaskId(id).localId}.sqlite`),
    mode: "immediate",
    timeoutMs: 100,
  });
  const outside = mkdtempSync(join(tmpdir(), "keiyaku-task-outside-"));
  const outsideFile = join(outside, "reset-custody-race.md");
  writeFileSync(outsideFile, "outside\n");
  const namespace = join(root, ".keiyaku", "tasks", "foo");
  const pending = nukeTaskAuthority(tasks.root, { timeoutMs: 1_000 });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    rmSync(namespace, { recursive: true, force: true });
    symlinkSync(outside, namespace, "dir");
  } finally {
    lock.close();
  }

  await assert.rejects(pending, /Task authority custody violation/u);
  assert.equal(readFileSync(outsideFile, "utf8"), "outside\n");
  rmSync(outside, { recursive: true, force: true });
});

test("task lock cancellation propagates and exceptional actions release held locks", async () => {
  const { tasks } = await world(),
    id = acceptedId(await tasks.add({ title: "Cancel" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task", `${parseTaskId(id).localId}.sqlite`);
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  const controller = new AbortController();
  const pending = tasks.task({ id }).start({ signal: controller.signal });
  controller.abort(new Error("cancel task"));
  await assert.rejects(pending, /cancel task/u);
  held.close();

  await assert.rejects(
    withTaskLocks({ world: tasks.root, allocation: false, ids: [id] }, async () => {
      throw new Error("action failed");
    }),
    /action failed/u,
  );
  assert.equal((await tasks.task({ id }).start()).kind, "accepted");
});

test("nested compose retains cleanup diagnostics from inner and outer locks", { concurrency: false }, async () => {
  const { tasks } = await world();
  const originalClose = DatabaseSync.prototype.close;
  let releases = 0;
  DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
    releases += 1;
    try {
      throw new Error(`release-${releases}`);
    } finally {
      originalClose.call(this);
    }
  };
  try {
    const result = await tasks.compose({ markdown: "+ Nested compose\n" });
    assert.ok(result.kind === "accepted", "expected result.kind = \"accepted\"");
    assert.deepEqual(result.cleanup, {
      kind: "lock-release-failed",
      diagnostics: ["cannot release SQLite lock: release-1", "cannot release SQLite lock: release-2"],
    });
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }
});

test("task action failure retains a close failure", { concurrency: false }, async () => {
  const { tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Action failure" }));
  const originalClose = DatabaseSync.prototype.close;
  let releases = 0;
  DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
    releases += 1;
    try {
      throw new Error("release after action failure");
    } finally {
      originalClose.call(this);
    }
  };
  try {
    await assert.rejects(
      withTaskLocks({ world: tasks.root, allocation: false, ids: [id] }, async () => {
        throw new Error("action failure");
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /action failure/u);
        assert.match(String(error.errors[1]), /cannot release SQLite lock: release after action failure/u);
        return true;
      },
    );
    assert.equal(releases, 1);
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }
});

test("partial task composition retains committed changes when lock cleanup fails", { concurrency: false }, async () => {
  const { tasks, root } = await world();
  const first = await tasks.add({ title: "Partial first" });
  const second = await tasks.add({ title: "Partial second" });
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  if (first.kind !== "accepted" || second.kind !== "accepted") return;
  const originalClose = DatabaseSync.prototype.close;
  let signalCalls = 0;
  const controller = new AbortController();
  controller.signal.throwIfAborted = (): void => {
    signalCalls += 1;
    if (signalCalls === 4) writeFileSync(authorityPath(root, second.value.id), "changed\n");
  };
  DatabaseSync.prototype.close = function patchedClose(this: DatabaseSync): void {
    try {
      throw new Error("release after partial composition");
    } finally {
      originalClose.call(this);
    }
  };
  try {
    const result = await tasks.compose({
      markdown: [`@${first.value.id}`, "pri = 1", `@${second.value.id}`, "pri = 1", ""].join("\n"),
      signal: controller.signal,
    });
    assert.ok(result.kind === "incomplete", "expected result.kind = \"incomplete\"");
    assert.equal(result.documentChanges.length, 1);
    assert.deepEqual(result.cleanup, {
      kind: "lock-release-failed",
      diagnostics: [
        "cannot release SQLite lock: release after partial composition",
        "cannot release SQLite lock: release after partial composition",
      ],
    });
  } finally {
    DatabaseSync.prototype.close = originalClose;
  }
});

test("manual predecessor movement is best-effort detected and idle lock deletion never changes authority", async () => {
  const { tasks } = await world(),
    id = acceptedId(await tasks.add({ title: "Manual" }));
  const path = authorityPath(tasks.root, id),
    original = readFileSync(path),
    manual = Buffer.concat([original, Buffer.from("manual edit\n")]);
  writeFileSync(path, manual);
  // This covers an external edit observed before replacement; portable rename
  // cannot prove an arbitrary writer stayed absent after the comparison.
  assert.equal(
    await replaceAuthority({ world: tasks.root, id, expected: original, next: Buffer.from("replacement") }),
    "concurrent-modification",
  );
  assert.deepEqual(readFileSync(path), manual);
  writeFileSync(path, original);
  assert.equal((await tasks.task({ id }).start()).kind, "accepted");
  const lock = join(tasks.root, ".keiyaku", "locks", "task", `${parseTaskId(id).localId}.sqlite`);
  unlinkSync(lock);
  assert.equal((await tasks.task({ id }).done()).kind, "accepted");
  assert.equal((await tasks.task({ id }).read())?.task.state, "done");
});

test("direct package Tasks uses root namespace without reading local context", async () => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Existing" }));
  mkdirSync(join(root, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "namespace", "current"), "Bad Namespace\n");
  const listed = await tasks.list();
  assert.equal(listed.kind, "accepted");
  assert.equal((await tasks.task({ id }).read())?.task.id, id);
});

function treeIds(node: TaskTreeNode): readonly string[] {
  return [node.task.id, ...node.children.flatMap(treeIds)];
}

test("task tree is parent decomposition with no needs residue", async () => {
  const { tasks } = await world();
  const root = acceptedId(await tasks.add({ title: "Area" }));
  const need = acceptedId(await tasks.add({ title: "Need" }));
  const later = acceptedId(await tasks.add({ title: "Zebra", parent: root }));
  const child = acceptedId(await tasks.add({ title: "Child", parent: root }));
  const nested = acceptedId(await tasks.add({ title: "Nested", parent: child, needs: [need] }));
  assert.equal((await tasks.task({ id: root }).update({ needs: [need] })).kind, "accepted");

  const tree = await tasks.task({ id: root }).tree();
  assert.ok(tree.kind === "accepted", "expected tree.kind = \"accepted\"");
  assert.deepEqual(treeIds(tree.value), [root, child, nested, later]);
  assert.deepEqual(
    tree.value.children.map((node) => node.task.id),
    [child, later],
  );
  assert.deepEqual(
    tree.value.children[0]?.children.map((node) => node.task.id),
    [nested],
  );
  assert.equal("needs" in tree.value, false);
  assert.equal("reference" in tree.value, false);
  assert.equal(treeIds(tree.value).includes(need), false);

  const shown = await tasks.task({ id: nested }).read();
  assert.deepEqual(
    shown?.needs.map((item) => item.id),
    [need],
  );
  assert.deepEqual(
    shown?.blockers.map((item) => item.id),
    [need],
  );
  assert.deepEqual(shown?.parent?.id, child);
  const blocked = await tasks.blocked({ scope: "world" });
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind === "accepted")
    assert.deepEqual(
      blocked.value.rows.map((row) => row.id),
      [root, nested],
    );
  const ready = await tasks.ready({ scope: "world" });
  assert.equal(ready.kind, "accepted");
  if (ready.kind === "accepted") {
    assert.deepEqual(
      ready.value.rows.map((row) => row.id),
      [child, need, later],
    );
  }

  assert.deepEqual(await tasks.task({ id: "task/missing" }).tree(), {
    kind: "refused",
    refusal: { kind: "task-missing", taskId: "task/missing" },
  });
  await assert.rejects(
    () => (tasks.task({ id: root }).tree as unknown as (input: unknown) => Promise<unknown>)({ full: true }),
    /tree accepts no input/u,
  );
});

test("task tree renders a parent cycle as a terminal cycle node", async () => {
  const { tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "First" }));
  const second = acceptedId(await tasks.add({ title: "Second", parent: first }));
  assert.equal((await tasks.task({ id: first }).update({ parent: second })).kind, "accepted");

  const tree = await tasks.task({ id: first }).tree();
  assert.ok(tree.kind === "accepted", "expected tree.kind = \"accepted\"");
  assert.equal(tree.value.cycle, undefined);
  assert.equal(tree.value.children.length, 1);
  assert.equal(tree.value.children[0]?.task.id, second);
  assert.equal(tree.value.children[0]?.cycle, undefined);
  assert.deepEqual(tree.value.children[0]?.children, [
    {
      task: { id: first, title: "First", state: "open", priority: 2 },
      cycle: true,
      children: [],
    },
  ]);
  assert.equal("reference" in (tree.value.children[0]?.children[0] ?? {}), false);
  assert.deepEqual((await tasks.doctor()).issues, [{ kind: "cycle", relation: "parent", tasks: [first, second] }]);
});

test("creation actor persists as createdBy and later mutations leave it unchanged", async () => {
  const { root, tasks } = await world();
  const envKey = "KEIYAKU_ACTOR_ID";
  const previous = process.env[envKey];
  process.env[envKey] = "env-must-not-leak";
  try {
    const unsigned = await tasks.add({ title: "Unsigned" });
    assert.equal(unsigned.kind, "accepted");
    if (unsigned.kind === "accepted") assert.equal("createdBy" in unsigned.value, false);

    const added = await tasks.add({ title: "Authored", actor: "flagship" });
    assert.ok(added.kind === "accepted", "expected added.kind = \"accepted\"");
    assert.equal(added.value.createdBy, "flagship");
    const addedPath = authorityPath(root, added.value.id);
    assert.match(readFileSync(addedPath, "utf8"), /^createdBy: flagship$/mu);

    const fromDocument = await tasks.addDocument({
      markdown: "---\ntitle: From document\n---\n",
      actor: "document-actor",
    });
    assert.equal(fromDocument.kind, "accepted");
    if (fromDocument.kind === "accepted") assert.equal(fromDocument.value.createdBy, "document-actor");
    await assert.rejects(
      tasks.addDocument({ markdown: "---\ntitle: Illegal\ncreatedBy: sneaky\n---\n" }),
      /unknown task front matter key/u,
    );
    assert.equal(await tasks.task({ id: "task/illegal" }).read(), null);

    const composed = await tasks.compose({
      markdown: ["+ Composed", "as = composed", `@${added.value.id}`, "pri = 1"].join("\n"),
      actor: "composer",
    });
    assert.ok(composed.kind === "accepted", "expected composed.kind = \"accepted\"");
    assert.equal(composed.documentChanges.length, 2);
    const composedId =
      composed.kind === "accepted"
        ? composed.documentChanges.find((change) => change.taskId.startsWith("task/composed-"))?.taskId
        : undefined;
    const composedTask = composedId === undefined ? null : await tasks.task({ id: composedId }).read();
    const updatedExisting = await tasks.task({ id: added.value.id }).read();
    assert.equal(composedTask?.task.createdBy, "composer");
    assert.equal(updatedExisting?.task.createdBy, "flagship");
    assert.equal(updatedExisting?.task.priority, 1);

    const mutated = await tasks.task({ id: added.value.id }).update({ note: "changed" });
    assert.equal(mutated.kind, "accepted");
    if (mutated.kind === "accepted") assert.equal(mutated.value.task.createdBy, "flagship");
    for (const verb of ["start", "stop", "hold", "resume", "done"] as const) {
      const next = await lifecycle(tasks.task({ id: added.value.id }), verb);
      assert.equal(next.kind, "accepted");
      if (next.kind === "accepted") assert.equal(next.value.createdBy, "flagship");
    }
    const dropped = acceptedId(await tasks.add({ title: "Drop me", actor: "flagship" }));
    const drop = await tasks.task({ id: dropped }).drop();
    assert.equal(drop.kind, "accepted");
    if (drop.kind === "accepted") assert.equal(drop.value.createdBy, "flagship");
    const batchId = acceptedId(await tasks.add({ title: "Batch me", actor: "flagship" }));
    const batch = await tasks.batch({ verb: "hold", ids: [batchId] });
    assert.equal(batch.items[0]?.outcome.kind, "accepted");
    if (batch.items[0]?.outcome.kind === "accepted") assert.equal(batch.items[0].outcome.value.createdBy, "flagship");
    const settledId = acceptedId(await tasks.add({ title: "Settle me", actor: "flagship" }));
    const settled = await settleTask(tasks.root, settledId);
    assert.equal(settled.kind, "changed");
    if (settled.kind === "changed") assert.equal(settled.task.createdBy, "flagship");
    assert.equal((await tasks.task({ id: added.value.id }).read())?.task.createdBy, "flagship");

    const legacyPath = join(root, ".keiyaku", "tasks", "legacy.md");
    writeFileSync(
      legacyPath,
      serializeTaskDocument({
        id: "task/legacy" as TaskId,
        title: "Legacy",
        state: "open",
        priority: 2,
        needs: [],
        parent: null,
        supersedes: [],
        relates: [],
        note: "",
        createdAt: "2026-08-07T01:02:03.004Z",
        updatedAt: "2026-08-07T01:02:03.004Z",
        body: "",
      }),
    );
    const legacy = await tasks.task({ id: "task/legacy" }).read();
    assert.equal("createdBy" in (legacy?.task ?? {}), false);
    assert.equal((await tasks.task({ id: "task/legacy" }).update({ note: "still unsigned" })).kind, "accepted");
    assert.equal((await tasks.task({ id: "task/legacy" }).start()).kind, "accepted");
    assert.equal("createdBy" in ((await tasks.task({ id: "task/legacy" }).read())?.task ?? {}), false);
    assert.throws(() => tasks.add({ title: "Blank", actor: "  " }), /actor must be a nonblank string/u);
    assert.throws(() => tasks.task({ id: added.value.id }).update({ actor: "nope" } as never), /unknown field/u);
    assert.throws(() => tasks.task({ id: added.value.id }).start({ actor: "nope" } as never), /unknown field/u);
  } finally {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  }
});

test("public inputs reject unknown fields before observing authority", async () => {
  const { tasks } = await world();
  assert.throws(() => tasks.add({ title: "Bad", extra: true } as never), /unknown field/u);
  assert.throws(() => tasks.add({ title: "Bad", namespace: ["nested/escape"] }), /canonical segments/u);
  assert.throws(() => tasks.add({ title: "Bad", needs: ["task/a", "task/a"] }), /must not contain duplicates/u);
  assert.throws(() => tasks.add({ title: "Bad", state: "started" as never }), /state is invalid/u);
  const id = acceptedId(await tasks.add({ title: "Valid" }));
  assert.throws(() => tasks.task({ id }).update({ title: "   " }), /title must be nonblank/u);
  assert.throws(() => tasks.task({ id }).start({ extra: true } as never), /unknown field/u);
  await assert.rejects(tasks.list({ scope: "nearby" } as never), /scope must be namespace or world/u);
  assert.throws(() => Tasks.of({ root: tasks.root } as never), /Tasks.of world/u);
});

test("board reports malformed Markdown Task authority as corruption", async () => {
  const { root, tasks } = await world();
  acceptedId(await tasks.add({ title: "Corrupted authority" }));
  writeFileSync(join(root, ".keiyaku", "tasks", "corrupted-authority.md"), "not a Task document\n");

  await assert.rejects(tasks.list({ scope: "world", selection: "all" }), TaskAuthorityCorruptionError);
});

test("targeted reads ignore unrelated malformed and symlink authorities", async () => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Targeted authority" }));
  const directory = join(root, ".keiyaku", "tasks");
  for (let index = 0; index < 25; index += 1)
    writeFileSync(join(directory, `unrelated-${String(index).padStart(2, "0")}.md`), "not a Task document\n");
  symlinkSync(join(root, "outside.md"), join(directory, "unrelated-link.md"));

  const shown = await tasks.task({ id }).read();
  assert.equal(shown?.task.id, id);
});

test("forced-local Task mutation execution preserves owner validation and authenticated creation actor", async () => {
  const { root, tasks } = await world();
  const result = await executeTaskMutation({
    world: tasks.root,
    requester: "aku/parent/00000001",
    request: { action: "task.add", input: { title: "Forwarded", body: "exact\nbody", namespace: [] } },
  });
  assert.equal("kind" in result && result.kind, "accepted");
  if (!("kind" in result) || result.kind !== "accepted" || !("value" in result) || "task" in result.value)
    assert.fail("expected accepted task mutation result");
  assert.equal(result.value.createdBy, "aku/parent/00000001");
  assert.equal(
    (
      await Tasks.of(await World.at(root))
        .task({ id: result.value.id })
        .read()
    )?.task.body,
    "exact\nbody",
  );
  assert.throws(
    () => decodeTaskMutationRequest("task.add", { input: { title: "Invalid", actor: "forged" } }),
    /invalid task\.add request/u,
  );
  assert.deepEqual(decodeTaskMutationRequest("task.start", { ids: ["task/one", "task/two"] }), {
    action: "task.start",
    ids: ["task/one", "task/two"],
  });
  assert.throws(() => decodeTaskMutationRequest("task.start", { ids: [] }), /invalid task\.start request/u);
});
