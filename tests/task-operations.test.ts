import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskAuthorityCorruptionError, Tasks, type TaskId, type TaskTreeNode } from "../src/task/index.js";
import { decodeTaskMutationRequest, executeTaskMutation, type TaskMutationBodyRequest } from "../src/task/mutation.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { parseTaskDocument, serializeTaskDocument } from "../src/task/document.js";
import { parseTaskId } from "../src/task/identity.js";
import { settleTask } from "../src/task/operations.js";
import { DEFAULT_TASK_LOCK_TIMEOUT_MS, replaceAuthority, withTaskLocks } from "../src/task/store.js";
import { World, type WorldRoot } from "../src/world.js";

type Assert<Condition extends true> = Condition;

export type TaskBodyWorldRequiresCanonicalMint = Assert<
  [TaskMutationBodyRequest["world"]] extends [WorldRoot] ? false : true
>;

async function world(): { root: string; tasks: ReturnType<typeof Tasks.of> } {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-tasks-"));
  mkdirSync(join(root, ".keiyaku"));
  return {
    root,
    tasks: Tasks.of(await World.at(root)),
  };
}
function acceptedId(result: Awaited<ReturnType<ReturnType<typeof Tasks.of>["add"]>>): TaskId {
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("task add failed");
  return result.value.id;
}

test("note is replaceable authority and product timestamps advance only on change", async () => {
  const { tasks } = await world();
  const added = await tasks.add({ title: "Timestamped", note: "first" });
  assert.equal(added.kind, "accepted");
  if (added.kind !== "accepted") return;
  assert.equal(added.value.note, "first");
  assert.equal(added.value.createdAt, added.value.updatedAt);
  assert.equal(new Date(added.value.createdAt).toISOString(), added.value.createdAt);

  const replaced = await tasks.task({ id: added.value.id }).update({ note: "second" });
  assert.equal(replaced.kind, "accepted");
  if (replaced.kind !== "accepted") return;
  assert.equal(replaced.value.task.note, "second");
  assert.equal(replaced.value.task.createdAt, added.value.createdAt);
  assert.ok(replaced.value.task.updatedAt > added.value.updatedAt);
  assert.match(replaced.value.documentDiff, /-note: first/u);
  assert.match(replaced.value.documentDiff, /\+note: second/u);

  const unchanged = await tasks.task({ id: added.value.id }).update({ note: "second" });
  assert.equal(unchanged.kind, "accepted");
  if (unchanged.kind !== "accepted") return;
  assert.equal(unchanged.value.documentDiff, "");
  assert.equal(unchanged.value.task.updatedAt, replaced.value.task.updatedAt);
});

test("ordinary mutations advance a non-later timestamp by one millisecond", async () => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Future timestamp" }));
  const before = await tasks.task({ id }).read();
  if (before === null) return;
  const future = "2099-01-01T00:00:00.000Z";
  writeFileSync(
    join(root, ".keiyaku", "tasks", "future-timestamp.md"),
    serializeTaskDocument({ ...before.task, updatedAt: future }),
  );

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
      .every((item) => item.outcome.value.note === "completed"),
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

test("Tasks creates root authority without Contract coupling", async () => {
  const { tasks } = await world();
  const rootId = acceptedId(await tasks.add({ title: "Root task" }));
  assert.equal(rootId, "task/root-task");
  const nestedId = acceptedId(
    await tasks.add({ title: "Nested task", namespace: ["contract", "inside"], state: "in_progress" }),
  );
  assert.equal(nestedId, "task/contract/inside/nested-task");
  assert.equal((await tasks.task({ id: nestedId }).read())?.task.state, "in_progress");
  assert.throws(
    () => tasks.add({ title: "Coupled", contractId: "kei/forbidden" } as never),
    /unknown field: contractId/u,
  );
  assert.deepEqual(
    (await tasks.list({ namespace: ["contract", "inside"] })).kind === "accepted"
      ? (
          (await tasks.list({ namespace: ["contract", "inside"] })) as {
            kind: "accepted";
            value: { rows: readonly { id: string }[] };
          }
        ).value.rows.map((row) => row.id)
      : [],
    [nestedId],
  );
  const worldList = await tasks.list({ scope: "world", selection: "all" });
  assert.equal(worldList.kind, "accepted");
  if (worldList.kind === "accepted") {
    assert.deepEqual(worldList.value.rows.map((row) => row.id).sort(), [nestedId, rootId].sort());
    assert.deepEqual(
      { total: worldList.value.total, returned: worldList.value.returned, truncated: worldList.value.truncated },
      { total: 2, returned: 2, truncated: false },
    );
  }
});

test("lifecycle, readiness, blocked projection, update diff, and batch results compose", async () => {
  const { tasks } = await world();
  const dependency = acceptedId(await tasks.add({ title: "Dependency" }));
  const dependent = acceptedId(await tasks.add({ title: "Dependent", needs: [dependency] }));
  assert.deepEqual(
    (await tasks.ready()).kind === "accepted"
      ? ((await tasks.ready()) as { kind: "accepted"; value: { rows: readonly { id: string }[] } }).value.rows.map(
          (row) => row.id,
        )
      : [],
    [dependency],
  );
  assert.equal((await tasks.task({ id: dependent }).start()).kind, "accepted");
  const blocked = await tasks.blocked();
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind === "accepted")
    assert.deepEqual(
      blocked.value.rows.map((row) => row.id),
      [dependent],
    );
  assert.equal((await tasks.task({ id: dependency }).done()).kind, "accepted");
  assert.equal(
    (await tasks.blocked()).kind === "accepted"
      ? ((await tasks.blocked()) as { kind: "accepted"; value: { rows: readonly unknown[] } }).value.rows.length
      : -1,
    0,
  );
  const updated = await tasks.task({ id: dependent }).update({ title: "Dependent renamed", appendBody: "body" });
  assert.equal(updated.kind, "accepted");
  if (updated.kind === "accepted") {
    assert.match(updated.value.documentDiff, /Dependent renamed/u);
    assert.match(updated.value.documentDiff, /task\/dependent\.md/u);
    assert.equal(updated.value.documentDiff.includes(tasks.root), false);
    assert.equal(updated.value.task.body, "body");
  }
  const batch = await tasks.batch({ verb: "done", ids: [dependent, "task/missing"] });
  assert.deepEqual(
    batch.items.map((item) => item.outcome.kind),
    ["accepted", "refused"],
  );
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
    assert.deepEqual(
      { total: selected.value.total, returned: selected.value.returned, truncated: selected.value.truncated },
      { total: 2, returned: 1, truncated: true },
    );
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

test("detail and query agree that blocks is reverse needs membership", async () => {
  const { tasks } = await world();
  const blocker = acceptedId(await tasks.add({ title: "A" }));
  const blocked = acceptedId(await tasks.add({ title: "B", needs: [blocker] }));
  const other = acceptedId(await tasks.add({ title: "C" }));

  const shown = await tasks.task({ id: blocker }).read();
  assert.deepEqual(
    shown?.blocks.map((item) => item.id),
    [blocked],
  );
  const shownBlocked = await tasks.task({ id: blocked }).read();
  assert.deepEqual(
    shownBlocked?.blocks.map((item) => item.id),
    [],
  );

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
      [blocked, other],
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

test("graph mutation admits cycles, doctor diagnoses them, and lifecycle writers serialize", async () => {
  const { tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "First" })),
    second = acceptedId(await tasks.add({ title: "Second", needs: [first] }));
  const cycle = await tasks.task({ id: first }).update({ needs: [second] });
  assert.equal(cycle.kind, "accepted");
  assert.deepEqual((await tasks.doctor()).issues, [{ kind: "cycle", relation: "needs", tasks: [first, second] }]);
  assert.equal((await tasks.add({ title: "Unrelated after disease" })).kind, "accepted");
  assert.equal((await tasks.task({ id: first }).update({ title: "First renamed" })).kind, "accepted");
  const outcomes = await Promise.all([tasks.task({ id: first }).start(), tasks.task({ id: first }).start()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["accepted", "refused"]);
});

test("concurrent same-title creation allocates stable unique suffixes", async () => {
  const { tasks } = await world();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => tasks.add({ title: "Collision" })));
  assert.ok(outcomes.every((outcome) => outcome.kind === "accepted"));
  const ids = outcomes.flatMap((outcome) => (outcome.kind === "accepted" ? [outcome.value.id] : []));
  assert.deepEqual(ids.sort(), [
    "task/collision",
    "task/collision-2",
    "task/collision-3",
    "task/collision-4",
    "task/collision-5",
    "task/collision-6",
  ]);
});

test("reverse dependency writers both admit and leave diagnosis to doctor", async () => {
  const { tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "First" })),
    second = acceptedId(await tasks.add({ title: "Second" }));
  const outcomes = await Promise.all([
    tasks.task({ id: first }).update({ needs: [second] }),
    tasks.task({ id: second }).update({ needs: [first] }),
  ]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.kind),
    ["accepted", "accepted"],
  );
  assert.deepEqual((await tasks.doctor()).issues, [{ kind: "cycle", relation: "needs", tasks: [first, second] }]);
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
  const path = join(root, ".keiyaku", "tasks", "subject.md");
  const document = parseTaskDocument(readFileSync(path), parseTaskId(subject));
  writeFileSync(path, serializeTaskDocument({ ...document, needs: ["task/missing"] }));

  assert.equal((await tasks.task({ id: subject }).update({ addNeeds: [valid] })).kind, "accepted");
  assert.deepEqual((await tasks.doctor()).issues, [
    { kind: "missing-target", taskId: subject, relation: "needs", target: "task/missing" },
  ]);
});

test("different task IDs and different worlds do not share task locks", async () => {
  const firstWorld = await world(),
    secondWorld = await world();
  const firstA = acceptedId(await firstWorld.tasks.add({ title: "A" }));
  const firstB = acceptedId(await firstWorld.tasks.add({ title: "B" }));
  const secondA = acceptedId(await secondWorld.tasks.add({ title: "A" }));
  const held = await acquireSqliteTransactionLock({
    path: join(firstWorld.tasks.root, ".keiyaku", "locks", "task", "a.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  try {
    assert.equal((await firstWorld.tasks.task({ id: firstB }).start()).kind, "accepted");
    assert.equal((await secondWorld.tasks.task({ id: secondA }).start()).kind, "accepted");
  } finally {
    held.close();
  }
  assert.equal(firstA, secondA);
});

test("allocation contention does not block relation updates", async () => {
  const { tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "First" }));
  const second = acceptedId(await tasks.add({ title: "Second" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task-allocation.sqlite");
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  try {
    assert.equal((await tasks.task({ id: first }).update({ needs: [second] })).kind, "accepted");
  } finally {
    held.close();
  }
});

test("task lock cancellation propagates and exceptional actions release held locks", async () => {
  const { tasks } = await world(),
    id = acceptedId(await tasks.add({ title: "Cancel" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task", "cancel.sqlite");
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

test("task lock wait budget defaults to three seconds and classifies busy cheaply", async () => {
  const { tasks } = await world(),
    id = acceptedId(await tasks.add({ title: "Busy" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task", "busy.sqlite");
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  const started = performance.now();
  try {
    assert.equal(DEFAULT_TASK_LOCK_TIMEOUT_MS, 3_000);
    assert.equal(
      await withTaskLocks(
        { world: tasks.root, allocation: false, ids: [id], timeoutMs: 25 },
        async () => "unreachable",
      ),
      "busy",
    );
    assert.ok(performance.now() - started < 1_000);
  } finally {
    held.close();
  }
});

test("manual predecessor movement is refused and idle lock deletion never changes authority", async () => {
  const { tasks } = await world(),
    id = acceptedId(await tasks.add({ title: "Manual" }));
  const path = join(tasks.root, ".keiyaku", "tasks", "manual.md"),
    original = readFileSync(path),
    manual = Buffer.concat([original, Buffer.from("manual edit\n")]);
  writeFileSync(path, manual);
  assert.equal(
    await replaceAuthority({ path, expected: original, next: Buffer.from("replacement") }),
    "concurrent-modification",
  );
  assert.deepEqual(readFileSync(path), manual);
  writeFileSync(path, original);
  assert.equal((await tasks.task({ id }).start()).kind, "accepted");
  const lock = join(tasks.root, ".keiyaku", "locks", "task", "manual.sqlite");
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
  assert.equal(tree.kind, "accepted");
  if (tree.kind !== "accepted") return;
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
  await assert.rejects(tasks.task({ id: root }).tree({ full: true } as never), /tree accepts no input/u);
});

test("task tree renders a parent cycle as a terminal cycle node", async () => {
  const { tasks } = await world();
  const first = acceptedId(await tasks.add({ title: "First" }));
  const second = acceptedId(await tasks.add({ title: "Second", parent: first }));
  assert.equal((await tasks.task({ id: first }).update({ parent: second })).kind, "accepted");

  const tree = await tasks.task({ id: first }).tree();
  assert.equal(tree.kind, "accepted");
  if (tree.kind !== "accepted") return;
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
    assert.equal(added.kind, "accepted");
    if (added.kind !== "accepted") return;
    assert.equal(added.value.createdBy, "flagship");
    const addedPath = join(root, ".keiyaku", "tasks", "authored.md");
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
      markdown: ["+ Composed", "as = composed", "@task/authored", "pri = 1"].join("\n"),
      actor: "composer",
    });
    assert.equal(composed.kind, "accepted");
    if (composed.kind !== "accepted") return;
    assert.equal(composed.documentChanges.length, 2);
    const composedTask = await tasks.task({ id: "task/composed" }).read();
    const updatedExisting = await tasks.task({ id: added.value.id }).read();
    assert.equal(composedTask?.task.createdBy, "composer");
    assert.equal(updatedExisting?.task.createdBy, "flagship");
    assert.equal(updatedExisting?.task.priority, 1);

    const mutated = await tasks.task({ id: added.value.id }).update({ note: "changed" });
    assert.equal(mutated.kind, "accepted");
    if (mutated.kind === "accepted") assert.equal(mutated.value.task.createdBy, "flagship");
    for (const verb of ["start", "stop", "hold", "resume", "done"] as const) {
      const next = await tasks.task({ id: added.value.id })[verb]();
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

test("board ignores non-Markdown regular files including writer temporary files", async () => {
  const { root, tasks } = await world();
  const id = acceptedId(await tasks.add({ title: "Markdown authority" }));
  const directory = join(root, ".keiyaku", "tasks");
  writeFileSync(join(directory, "notes.txt"), "not Task authority\n");
  writeFileSync(join(directory, ".tmp-0123456789abcdef"), "writer temporary\n");

  const listed = await tasks.list({ scope: "world", selection: "all" });
  assert.equal(listed.kind, "accepted");
  if (listed.kind === "accepted")
    assert.deepEqual(
      listed.value.rows.map((row) => row.id),
      [id],
    );
});

test("board reports malformed Markdown Task authority as corruption", async () => {
  const { root, tasks } = await world();
  acceptedId(await tasks.add({ title: "Corrupted authority" }));
  writeFileSync(join(root, ".keiyaku", "tasks", "corrupted-authority.md"), "not a Task document\n");

  await assert.rejects(tasks.list({ scope: "world", selection: "all" }), TaskAuthorityCorruptionError);
});

test("forced-local Task mutation execution preserves owner validation and authenticated creation actor", async () => {
  const { root, tasks } = await world();
  const result = await executeTaskMutation({
    world: tasks.root,
    requester: "aku/parent/00000001",
    request: { action: "task.add", input: { title: "Forwarded", body: "exact\nbody" } },
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted" || !("value" in result)) return;
  assert.equal(result.value.createdBy, "aku/parent/00000001");
  assert.equal(
    (
      await Tasks.of(await World.at(root))
        .task({ id: "task/forwarded" })
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
