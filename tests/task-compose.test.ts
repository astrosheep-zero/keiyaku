import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";

async function tasks() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-compose-"));
  mkdirSync(join(root, ".keiyaku"));
  return Tasks.of(await World.at(root));
}

async function idFor(product: Awaited<ReturnType<typeof tasks>>, title: string): Promise<string> {
  const listed = await product.list({ scope: "world", selection: "all" });
  if (listed.kind !== "accepted") throw new Error("Task list unavailable");
  const row = listed.value.rows.find((item) => item.title === title);
  if (row === undefined) throw new Error(`Task ${title} missing`);
  return row.id;
}

test("compose preserves fenced body bytes, aliases new nodes, and plans dependencies", async () => {
  const product = await tasks();
  const result = await product.compose({
    markdown: [
      "ns=feature/inside",
      "+ Child",
      "as = child",
      "parent = ^parent",
      "+ Parent",
      "as = parent",
      "pri = 1",
      "body <<BODY",
      "Parent body",
      "    four-space code",
      "+ this is body",
      "BODY",
      "",
    ].join("\n"),
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  const parentId = await idFor(product, "Parent"), childId = await idFor(product, "Child");
  assert.deepEqual(result.admissionOrder, [parentId, childId]);
  assert.deepEqual(result.aliases, [
    { alias: "child", taskId: childId },
    { alias: "parent", taskId: parentId },
  ]);
  assert.deepEqual(
    result.documentChanges.map((change) => change.taskId),
    result.admissionOrder,
  );
  const parent = await product.task({ id: parentId as `task/${string}` }).read();
  const child = await product.task({ id: childId as `task/${string}` }).read();
  assert.equal(child?.task.parent, parentId);
  assert.equal(parent?.task.body, "Parent body\n    four-space code\n+ this is body");
});

test("compose admits initial state on new nodes and accepts the widest unambiguous aliases", async () => {
  const product = await tasks();
  const result = await product.compose({
    markdown: [
      "+ In progress",
      "as = alias.with/slash_@mark",
      "state = in_progress",
      "+ On hold",
      "as = hold.alias",
      "state = on_hold",
      "parent = ^alias.with/slash_@mark",
      "+ Done",
      "state = done",
      "+ Dropped",
      "state = drop",
      "",
    ].join("\n"),
  });
  assert.equal(result.kind, "accepted");
  const inProgress = await idFor(product, "In progress"), onHold = await idFor(product, "On hold");
  assert.equal((await product.task({ id: inProgress as `task/${string}` }).read())?.task.state, "in_progress");
  assert.equal((await product.task({ id: onHold as `task/${string}` }).read())?.task.state, "on_hold");
  assert.equal((await product.task({ id: onHold as `task/${string}` }).read())?.task.parent, inProgress);
  assert.equal((await product.task({ id: (await idFor(product, "Done")) as `task/${string}` }).read())?.task.state, "done");
  assert.equal((await product.task({ id: (await idFor(product, "Dropped")) as `task/${string}` }).read())?.task.state, "drop");

  const invalidAlias = await product.compose({ markdown: "+ Invalid\nas = has space\n" });
  assert.equal(invalidAlias.kind, "refused");
  if (invalidAlias.kind === "refused") assert.match(invalidAlias.refusal.diagnostics[0]?.reason ?? "", /alias/u);
});

test("compose rejects state on existing nodes and non-assignment state operators", async () => {
  const product = await tasks();
  const existing = await product.add({ title: "Existing" });
  assert.equal(existing.kind, "accepted");
  if (existing.kind !== "accepted") return;
  const result = await product.compose({
    markdown: [`@${existing.value.id}`, "state = done", "+ New", "state += done", ""].join("\n"),
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.equal(result.refusal.diagnostics.length, 2);
  assert.equal((await product.task({ id: existing.value.id }).read())?.task.state, "open");
});

test("compose keeps @ references in the pre-existing board and exposes collision allocation", async () => {
  const product = await tasks();
  const foo = await product.add({ title: "Foo" });
  assert.equal(foo.kind, "accepted");
  if (foo.kind !== "accepted") return;
  const result = await product.compose({
    markdown: ["+ Foo", "as = fresh", `needs = @${foo.value.id}`, "", "+ Uses fresh", "needs = ^fresh", ""].join("\n"),
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  const freshId = result.aliases[0]!.taskId;
  const usesFreshId = await idFor(product, "Uses fresh");
  assert.match(freshId, /^task\/foo-[0-9a-f]{4}$/u);
  assert.equal((await product.task({ id: usesFreshId as `task/${string}` }).read())?.task.needs[0], freshId);
  assert.equal((await product.task({ id: freshId }).read())?.task.needs[0], foo.value.id);
});

test("compose supports relation removal and existing body replacement", async () => {
  const product = await tasks();
  const target = await product.add({ title: "Target" });
  assert.equal(target.kind, "accepted");
  if (target.kind !== "accepted") return;
  const existing = await product.add({ title: "Existing", needs: [target.value.id] });
  assert.equal(existing.kind, "accepted");
  if (existing.kind !== "accepted") return;
  const result = await product.compose({
    markdown: [`@${existing.value.id}`, `needs -= @${target.value.id}`, "body <<BODY", "new exact body", "BODY", ""].join("\n"),
  });
  assert.equal(result.kind, "accepted");
  const detail = await product.task({ id: existing.value.id }).read();
  assert.deepEqual(detail?.task.needs, []);
  assert.equal(detail?.task.body, "new exact body");
});

test("compose reports all planning errors and rejects cycles before writing", async () => {
  const product = await tasks();
  const result = await product.compose({
    markdown: [
      "+ Broken",
      "as = duplicate",
      "needs = @task/missing",
      "+ Another",
      "as = duplicate",
      "pri = high",
      "",
    ].join("\n"),
  });
  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.ok(result.refusal.diagnostics.length >= 3);
  assert.equal((await product.list({ scope: "world", selection: "all" })).kind, "accepted");

  const first = await product.add({ title: "First" });
  const second = await product.add({ title: "Second" });
  assert.equal(first.kind, "accepted");
  assert.equal(second.kind, "accepted");
  if (first.kind !== "accepted" || second.kind !== "accepted") return;
  const cycle = await product.compose({
    markdown: [`@${first.value.id}`, `needs = @${second.value.id}`, `@${second.value.id}`, `needs = @${first.value.id}`, ""].join("\n"),
  });
  assert.equal(cycle.kind, "refused");
  assert.equal((await product.task({ id: first.value.id }).read())?.task.needs.length, 0);
});

test("compose plan returns stable admission and body previews without writing", async () => {
  const product = await tasks();
  const result = await product.compose({
    plan: true,
    markdown: [
      "+ Child",
      "as = child",
      "needs = ^parent",
      "+ Parent",
      "as = parent",
      "body <<BODY",
      "body bytes",
      "BODY",
      "",
    ].join("\n"),
  });
  assert.equal(result.kind, "planned");
  if (result.kind !== "planned") return;
  const parentId = result.aliases.find((item) => item.alias === "parent")!.taskId;
  const childId = result.aliases.find((item) => item.alias === "child")!.taskId;
  assert.deepEqual(result.admissionOrder, [parentId, childId]);
  assert.equal(result.bodies[0]?.bytes, 10);
  const listed = await product.list({ scope: "world", selection: "all" });
  assert.equal(listed.kind, "accepted");
  if (listed.kind === "accepted") {
    assert.deepEqual(listed.value.rows, []);
    assert.equal(listed.value.hasMore, false);
  }
});

test("busy compose returns a reusable fenced recovery document", async () => {
  const product = await tasks();
  const held = await acquireSqliteTransactionLock({
    path: join(product.root, ".keiyaku", "locks", "task-allocation.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  let result;
  try {
    result = await product.compose({
      markdown: "+ Remaining\nas = remaining\nbody <<BODY\n+ literal\n    indented\nBODY\n",
    });
  } finally {
    held.close();
  }
  assert.equal(result.kind, "incomplete");
  if (result.kind !== "incomplete") return;
  assert.deepEqual(result.stopped, { kind: "retry", reason: "busy" });
  assert.match(result.draft, /^ns=\/\n\n\+ Remaining\nas = remaining\n/u);
  const replayed = await product.compose({ markdown: result.draft });
  assert.equal(replayed.kind, "accepted");
  const detail = await product.task({ id: (await idFor(product, "Remaining")) as `task/${string}` }).read();
  assert.equal(detail?.task.body, "+ literal\n    indented");
});

test("compose recovery drafts preserve a non-open initial state", async () => {
  const product = await tasks();
  const held = await acquireSqliteTransactionLock({
    path: join(product.root, ".keiyaku", "locks", "task-allocation.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  let result;
  try {
    result = await product.compose({ markdown: "+ Held\nas = held\nstate = on_hold\n" });
  } finally {
    held.close();
  }
  assert.equal(result.kind, "incomplete");
  if (result.kind !== "incomplete") return;
  assert.match(result.draft, /state = on_hold/u);
  const replayed = await product.compose({ markdown: result.draft });
  assert.equal(replayed.kind, "accepted");
  assert.equal((await product.task({ id: (await idFor(product, "Held")) as `task/${string}` }).read())?.task.state, "on_hold");
});

test("compose accepts empty documents without creating authority", async () => {
  const product = await tasks();
  assert.deepEqual(await product.compose({ markdown: "\n" }), {
    kind: "accepted",
    aliases: [],
    admissionOrder: [],
    documentChanges: [],
  });
});
