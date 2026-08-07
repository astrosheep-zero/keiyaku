import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Tasks } from "../src/task/index.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";

function tasks() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-compose-")); mkdirSync(join(root, ".keiyaku"));
  return Tasks.at({ path: root });
}

test("compose allocates nested tasks, resolves parents, and returns native diffs", async () => {
  const product = tasks();
  const result = await product.compose({ markdown: "ns=feature/inside\n+ Parent pri=1\nParent body\n  + Child needs=@task/feature/inside/parent\n\\+ literal body\n" });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.documentChanges.map((change) => change.taskId), ["task/feature/inside/child", "task/feature/inside/parent"]);
  assert.ok(result.documentChanges.every((change) => change.kind === "created" && change.documentDiff.length > 0));
  assert.ok(result.documentChanges.every((change) => change.documentDiff.includes(`${change.taskId}.md`) && !change.documentDiff.includes(product.root)));
  const child = await product.task({ id: "task/feature/inside/child" }).read();
  assert.equal(child?.task.parent, "task/feature/inside/parent");
  assert.equal(child?.task.body, "+ literal body");
});

test("compose updates existing tasks and accepts an empty change set", async () => {
  const product = tasks(), added = await product.add({ title: "Existing" });
  assert.equal(added.kind, "accepted");
  const result = await product.compose({ markdown: "@task/existing pri=0\nNew body\n" });
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") assert.equal(result.documentChanges.length, 1);
  const noChange = await product.compose({ markdown: "@task/existing pri=0\nNew body\n" });
  assert.deepEqual(noChange, { kind: "accepted", documentChanges: [] });
});

test("compose planning refusals write nothing", async () => {
  const product = tasks();
  const result = await product.compose({ markdown: "+ Broken needs=@task/missing\n" });
  assert.equal(result.kind, "refused");
  const all = await product.list({ scope: "world", selection: "all" });
  assert.deepEqual(all, { kind: "accepted", value: [] });
  const duplicate = await product.compose({ markdown: "+ Duplicate relates=@task/a,@task/a\n" });
  assert.equal(duplicate.kind, "refused");
  const existing = await product.add({ title: "Existing" });
  assert.equal(existing.kind, "accepted");
  const repeated = await product.compose({ markdown: "@task/existing pri=1\n@task/existing pri=2\n" });
  assert.equal(repeated.kind, "refused");
});

test("compose admits cycles and doctor owns their diagnosis", async () => {
  const product = tasks();
  assert.equal((await product.add({ title: "First" })).kind, "accepted");
  assert.equal((await product.add({ title: "Second" })).kind, "accepted");
  const result = await product.compose({ markdown: "@task/first needs=@task/second\n@task/second needs=@task/first\n" });
  assert.equal(result.kind, "accepted");
  assert.deepEqual((await product.doctor()).issues, [{ kind: "cycle", relation: "needs", tasks: ["task/first", "task/second"] }]);
});

test("compose busy returns canonical remaining DSL that can be replayed directly", async () => {
  const product = tasks();
  const held = await acquireSqliteTransactionLock({ path: join(product.root, ".keiyaku", "locks", "task-allocation.sqlite"), mode: "immediate", timeoutMs: 100 });
  let result;
  try { result = await product.compose({ markdown: "+ Remaining\n\\+ literal\n\\@task/not-a-node\n\\\\leading slash\n" }); }
  finally { held.close(); }
  assert.equal(result.kind, "incomplete");
  if (result.kind !== "incomplete") return;
  assert.deepEqual(result.stopped, { kind: "retry", reason: "busy" });
  assert.match(result.draft, /^ns=\n\+ Remaining /u);
  const replayed = await product.compose({ markdown: result.draft });
  assert.equal(replayed.kind, "accepted");
  const detail = await product.task({ id: "task/remaining" }).read();
  assert.equal(detail?.task.body, "+ literal\n@task/not-a-node\n\\leading slash");
});
