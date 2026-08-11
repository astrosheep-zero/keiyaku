import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Tasks, type TaskId } from "../src/task/index.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { parseTaskDocument, serializeTaskDocument } from "../src/task/document.js";
import { parseTaskId } from "../src/task/identity.js";
import { replaceAuthority, withTaskLocks } from "../src/task/store.js";
import { World } from "../src/world.js";

function world(): { root: string; tasks: ReturnType<typeof Tasks.of> } {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-tasks-")); mkdirSync(join(root, ".keiyaku"));
  return { root, tasks: Tasks.of(World.at(root)) };
}
function acceptedId(result: Awaited<ReturnType<ReturnType<typeof Tasks.of>["add"]>>): TaskId {
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("task add failed");
  return result.value.id;
}

test("note is replaceable authority and product timestamps advance only on change", async () => {
  const { tasks } = world();
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

test("drop and batch drop replace note while preserving creation time", async () => {
  const { tasks } = world();
  const one = acceptedId(await tasks.add({ title: "One", note: "old" }));
  const before = await tasks.task({ id: one }).read();
  const dropped = await tasks.task({ id: one }).drop({ note: "obsolete" });
  assert.equal(dropped.kind, "accepted");
  if (dropped.kind === "accepted") {
    assert.equal(dropped.value.state, "drop");
    assert.equal(dropped.value.note, "obsolete");
    assert.equal(dropped.value.createdAt, before?.task.createdAt);
    assert.ok(dropped.value.updatedAt > (before?.task.updatedAt ?? ""));
  }

  const two = acceptedId(await tasks.add({ title: "Two" })), three = acceptedId(await tasks.add({ title: "Three" }));
  const batch = await tasks.batch({ verb: "drop", ids: [two, three], note: "cancelled" });
  assert.ok(batch.items.every((item) => item.outcome.kind === "accepted" && item.outcome.value.note === "cancelled"));
  assert.throws(() => tasks.batch({ verb: "done", ids: [two], note: "invalid" }), /valid only for drop/u);
});

test("Tasks creates root and nested authority without Contract coupling", async () => {
  const { tasks } = world();
  const rootId = acceptedId(await tasks.add({ title: "Root task" }));
  assert.equal(rootId, "task/root-task");
  await tasks.setNamespace({ namespace: ["contract", "inside"] });
  const nestedId = acceptedId(await tasks.add({ title: "Nested task", state: "in_progress" }));
  assert.equal(nestedId, "task/contract/inside/nested-task");
  assert.equal((await tasks.task({ id: nestedId }).read())?.task.state, "in_progress");
  assert.throws(() => tasks.add({ title: "Coupled", contractId: "kei/forbidden" } as never), /unknown field: contractId/u);
  assert.deepEqual((await tasks.list()).kind === "accepted" ? (await tasks.list() as { kind: "accepted"; value: readonly { id: string }[] }).value.map((row) => row.id) : [], [nestedId]);
  const worldList = await tasks.list({ scope: "world", selection: "all" });
  assert.equal(worldList.kind, "accepted");
  if (worldList.kind === "accepted") assert.deepEqual(worldList.value.map((row) => row.id).sort(), [nestedId, rootId].sort());
});

test("lifecycle, readiness, blocked projection, update diff, and batch results compose", async () => {
  const { tasks } = world();
  const dependency = acceptedId(await tasks.add({ title: "Dependency" }));
  const dependent = acceptedId(await tasks.add({ title: "Dependent", needs: [dependency] }));
  assert.deepEqual((await tasks.ready()).kind === "accepted" ? (await tasks.ready() as { kind: "accepted"; value: readonly { id: string }[] }).value.map((row) => row.id) : [], [dependency]);
  assert.equal((await tasks.task({ id: dependent }).start()).kind, "accepted");
  const blocked = await tasks.blocked();
  assert.equal(blocked.kind, "accepted");
  if (blocked.kind === "accepted") assert.deepEqual(blocked.value.map((row) => row.id), [dependent]);
  assert.equal((await tasks.task({ id: dependency }).done()).kind, "accepted");
  assert.equal((await tasks.blocked()).kind === "accepted" ? (await tasks.blocked() as { kind: "accepted"; value: readonly unknown[] }).value.length : -1, 0);
  const updated = await tasks.task({ id: dependent }).update({ title: "Dependent renamed", appendBody: "body" });
  assert.equal(updated.kind, "accepted");
  if (updated.kind === "accepted") {
    assert.match(updated.value.documentDiff, /Dependent renamed/u);
    assert.match(updated.value.documentDiff, /task\/dependent\.md/u);
    assert.equal(updated.value.documentDiff.includes(tasks.root), false);
  }
  const batch = await tasks.batch({ verb: "done", ids: [dependent, "task/missing"] });
  assert.deepEqual(batch.items.map((item) => item.outcome.kind), ["accepted", "refused"]);
});

test("graph mutation admits cycles, doctor diagnoses them, and lifecycle writers serialize", async () => {
  const { tasks } = world();
  const first = acceptedId(await tasks.add({ title: "First" })), second = acceptedId(await tasks.add({ title: "Second", needs: [first] }));
  const cycle = await tasks.task({ id: first }).update({ needs: [second] });
  assert.equal(cycle.kind, "accepted");
  assert.deepEqual((await tasks.doctor()).issues, [{ kind: "cycle", relation: "needs", tasks: [first, second] }]);
  assert.equal((await tasks.add({ title: "Unrelated after disease" })).kind, "accepted");
  assert.equal((await tasks.task({ id: first }).update({ title: "First renamed" })).kind, "accepted");
  const outcomes = await Promise.all([tasks.task({ id: first }).start(), tasks.task({ id: first }).start()]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind).sort(), ["accepted", "refused"]);
});

test("concurrent same-title creation allocates stable unique suffixes", async () => {
  const { tasks } = world();
  const outcomes = await Promise.all(Array.from({ length: 6 }, () => tasks.add({ title: "Collision" })));
  assert.ok(outcomes.every((outcome) => outcome.kind === "accepted"));
  const ids = outcomes.flatMap((outcome) => outcome.kind === "accepted" ? [outcome.value.id] : []);
  assert.deepEqual(ids.sort(), ["task/collision", "task/collision-2", "task/collision-3", "task/collision-4", "task/collision-5", "task/collision-6"]);
});

test("reverse dependency writers both admit and leave diagnosis to doctor", async () => {
  const { tasks } = world();
  const first = acceptedId(await tasks.add({ title: "First" })), second = acceptedId(await tasks.add({ title: "Second" }));
  const outcomes = await Promise.all([
    tasks.task({ id: first }).update({ needs: [second] }),
    tasks.task({ id: second }).update({ needs: [first] }),
  ]);
  assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["accepted", "accepted"]);
  assert.deepEqual((await tasks.doctor()).issues, [{ kind: "cycle", relation: "needs", tasks: [first, second] }]);
});

test("relation mutation rejects only newly declared missing and self targets", async () => {
  const { tasks } = world(), id = acceptedId(await tasks.add({ title: "Subject" }));
  const missing = await tasks.task({ id }).update({ needs: ["task/missing"] });
  assert.equal(missing.kind, "refused");
  if (missing.kind === "refused") assert.equal(missing.refusal.kind, "invalid-graph");
  const self = await tasks.task({ id }).update({ relates: [id] });
  assert.equal(self.kind, "refused");
  if (self.kind === "refused") assert.equal(self.refusal.kind, "invalid-graph");
});

test("existing graph disease does not adjudicate an unrelated relation addition", async () => {
  const { root, tasks } = world();
  const subject = acceptedId(await tasks.add({ title: "Subject" }));
  const valid = acceptedId(await tasks.add({ title: "Valid target" }));
  const path = join(root, ".keiyaku", "tasks", "subject.md");
  const document = parseTaskDocument(readFileSync(path), parseTaskId(subject));
  writeFileSync(path, serializeTaskDocument({ ...document, needs: ["task/missing"] }));

  assert.equal((await tasks.task({ id: subject }).update({ addNeeds: [valid] })).kind, "accepted");
  assert.deepEqual((await tasks.doctor()).issues, [{ kind: "missing-target", taskId: subject, relation: "needs", target: "task/missing" }]);
});

test("different task IDs and different worlds do not share task locks", async () => {
  const firstWorld = world(), secondWorld = world();
  const firstA = acceptedId(await firstWorld.tasks.add({ title: "A" }));
  const firstB = acceptedId(await firstWorld.tasks.add({ title: "B" }));
  const secondA = acceptedId(await secondWorld.tasks.add({ title: "A" }));
  const held = await acquireSqliteTransactionLock({ path: join(firstWorld.tasks.root, ".keiyaku", "locks", "task", "a.sqlite"), mode: "immediate", timeoutMs: 100 });
  try {
    assert.equal((await firstWorld.tasks.task({ id: firstB }).start()).kind, "accepted");
    assert.equal((await secondWorld.tasks.task({ id: secondA }).start()).kind, "accepted");
  } finally { held.close(); }
  assert.equal(firstA, secondA);
});

test("allocation contention does not block relation updates", async () => {
  const { tasks } = world();
  const first = acceptedId(await tasks.add({ title: "First" }));
  const second = acceptedId(await tasks.add({ title: "Second" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task-allocation.sqlite");
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  try { assert.equal((await tasks.task({ id: first }).update({ needs: [second] })).kind, "accepted"); }
  finally { held.close(); }
});

test("task lock cancellation propagates and exceptional actions release held locks", async () => {
  const { tasks } = world(), id = acceptedId(await tasks.add({ title: "Cancel" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task", "cancel.sqlite");
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  const controller = new AbortController();
  const pending = tasks.task({ id }).start({ signal: controller.signal }); controller.abort(new Error("cancel task"));
  await assert.rejects(pending, /cancel task/u); held.close();

  await assert.rejects(withTaskLocks({ world: tasks.root, allocation: false, ids: [id] }, async () => { throw new Error("action failed"); }), /action failed/u);
  assert.equal((await tasks.task({ id }).start()).kind, "accepted");
});

test("task writers classify the fixed three-second lock wait as busy", async () => {
  const { tasks } = world(), id = acceptedId(await tasks.add({ title: "Busy" }));
  const path = join(tasks.root, ".keiyaku", "locks", "task", "busy.sqlite");
  const held = await acquireSqliteTransactionLock({ path, mode: "immediate", timeoutMs: 100 });
  const started = performance.now();
  try {
    assert.deepEqual(await tasks.task({ id }).start(), { kind: "retry", reason: "busy" });
    assert.ok(performance.now() - started >= 2_900);
  } finally { held.close(); }
});

test("manual predecessor movement is refused and idle lock deletion never changes authority", async () => {
  const { tasks } = world(), id = acceptedId(await tasks.add({ title: "Manual" }));
  const path = join(tasks.root, ".keiyaku", "tasks", "manual.md"), original = readFileSync(path), manual = Buffer.concat([original, Buffer.from("manual edit\n")]);
  writeFileSync(path, manual);
  assert.equal(replaceAuthority({ path, expected: original, next: Buffer.from("replacement") }), "concurrent-modification");
  assert.deepEqual(readFileSync(path), manual);
  writeFileSync(path, original);
  assert.equal((await tasks.task({ id }).start()).kind, "accepted");
  const lock = join(tasks.root, ".keiyaku", "locks", "task", "manual.sqlite");
  unlinkSync(lock);
  assert.equal((await tasks.task({ id }).done()).kind, "accepted");
  assert.equal((await tasks.task({ id }).read())?.task.state, "done");
});

test("malformed current namespace refuses context consumers but not explicit TaskId reads", async () => {
  const { root, tasks } = world();
  const id = acceptedId(await tasks.add({ title: "Existing" }));
  mkdirSync(join(root, ".keiyaku", "namespace"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "namespace", "current"), "Bad Namespace\n");
  const listed = await tasks.list();
  assert.equal(listed.kind, "refused");
  if (listed.kind === "refused") {
    assert.equal(listed.refusal.kind, "invalid-namespace-context");
    if (listed.refusal.kind === "invalid-namespace-context") assert.equal(listed.refusal.path, join(tasks.root, ".keiyaku", "namespace", "current"));
  }
  assert.equal((await tasks.task({ id }).read())?.task.id, id);
  const namespace = await tasks.namespace();
  assert.equal(namespace.kind, "refused");
  if (namespace.kind === "refused") assert.equal(namespace.refusal.kind, "invalid-namespace-context");
});

test("public inputs reject unknown fields before observing authority", async () => {
  const { tasks } = world();
  assert.throws(() => tasks.add({ title: "Bad", extra: true } as never), /unknown field/u);
  assert.throws(() => tasks.add({ title: "Bad", namespace: ["nested/escape"] }), /canonical segments/u);
  assert.throws(() => tasks.add({ title: "Bad", needs: ["task/a", "task/a"] }), /must not contain duplicates/u);
  assert.throws(() => tasks.add({ title: "Bad", state: "started" as never }), /state is invalid/u);
  const id = acceptedId(await tasks.add({ title: "Valid" }));
  assert.throws(() => tasks.task({ id }).update({ title: "   " }), /title must be nonblank/u);
  assert.throws(() => tasks.task({ id }).start({ extra: true } as never), /unknown field/u);
  await assert.rejects(tasks.list({ scope: "nearby" } as never), /scope must be namespace or world/u);
  assert.throws(() => Tasks.of({ root: tasks.root } as never), /WorldRoot/u);
});
