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
  assert.deepEqual(result.admissionOrder, ["task/feature/inside/parent", "task/feature/inside/child"]);
  assert.deepEqual(result.aliases, [
    { alias: "child", taskId: "task/feature/inside/child" },
    { alias: "parent", taskId: "task/feature/inside/parent" },
  ]);
  assert.deepEqual(
    result.documentChanges.map((change) => change.taskId),
    result.admissionOrder,
  );
  const parent = await product.task({ id: "task/feature/inside/parent" }).read();
  const child = await product.task({ id: "task/feature/inside/child" }).read();
  assert.equal(child?.task.parent, "task/feature/inside/parent");
  assert.equal(parent?.task.body, "Parent body\n    four-space code\n+ this is body");
});

test("compose keeps @ references in the pre-existing board and exposes collision allocation", async () => {
  const product = await tasks();
  assert.equal((await product.add({ title: "Foo" })).kind, "accepted");
  const result = await product.compose({
    markdown: ["+ Foo", "as = fresh", "needs = @task/foo", "", "+ Uses fresh", "needs = ^fresh", ""].join("\n"),
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.aliases, [{ alias: "fresh", taskId: "task/foo-2" }]);
  assert.equal((await product.task({ id: "task/uses-fresh" }).read())?.task.needs[0], "task/foo-2");
  assert.equal((await product.task({ id: "task/foo-2" }).read())?.task.needs[0], "task/foo");
});

test("compose supports relation removal and existing body replacement", async () => {
  const product = await tasks();
  assert.equal((await product.add({ title: "Target" })).kind, "accepted");
  assert.equal((await product.add({ title: "Existing", needs: ["task/target"] })).kind, "accepted");
  const result = await product.compose({
    markdown: ["@task/existing", "needs -= @task/target", "body <<BODY", "new exact body", "BODY", ""].join("\n"),
  });
  assert.equal(result.kind, "accepted");
  const detail = await product.task({ id: "task/existing" }).read();
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

  assert.equal((await product.add({ title: "First" })).kind, "accepted");
  assert.equal((await product.add({ title: "Second" })).kind, "accepted");
  const cycle = await product.compose({
    markdown: ["@task/first", "needs = @task/second", "@task/second", "needs = @task/first", ""].join("\n"),
  });
  assert.equal(cycle.kind, "refused");
  assert.equal((await product.task({ id: "task/first" }).read())?.task.needs.length, 0);
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
  assert.deepEqual(result.admissionOrder, ["task/parent", "task/child"]);
  assert.equal(result.bodies[0]?.bytes, 10);
  assert.equal((await product.list({ scope: "world", selection: "all" })).value?.total, 0);
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
  const detail = await product.task({ id: "task/remaining" }).read();
  assert.equal(detail?.task.body, "+ literal\n    indented");
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
