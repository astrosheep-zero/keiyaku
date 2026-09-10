import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";

async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-compose-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return Tasks.of(await World.at(root));
}

async function add(product: Tasks, title: string) {
  const result = await product.add({ title });
  assert.ok(result.kind === "accepted");
  return result.value.id;
}

async function rows(product: Tasks) {
  const result = await product.list({ scope: "world", selection: "all" });
  assert.ok(result.kind === "accepted");
  return result.value.rows;
}

test("compose plans aliases and existing references while preserving exact body and relation edits", async (t) => {
  const product = await fixture(t);
  const existing = await add(product, "Parent");
  const body = "Parent body\n    four-space code\n+ this is body";
  const result = await product.compose({
    markdown: [
      "ns=feature/inside",
      "+ Child",
      "as = child.with/slash_@mark",
      "parent = ^parent",
      "+ Parent",
      "as = parent",
      "pri = 1",
      `needs = @${existing}`,
      "body <<BODY",
      body,
      "BODY",
      "",
    ].join("\n"),
  });
  assert.ok(result.kind === "accepted");
  const parent = result.aliases.find(({ alias }) => alias === "parent")!.taskId;
  const child = result.aliases.find(({ alias }) => alias === "child.with/slash_@mark")!.taskId;
  assert.deepEqual(result.admissionOrder, [parent, child]);
  assert.deepEqual(result.documentChanges.map(({ taskId }) => taskId), [parent, child]);
  assert.match(parent, /^task\/feature\/inside\//u);
  assert.equal((await product.task({ id: child }).read())?.task.parent, parent);
  assert.equal((await product.task({ id: parent }).read())?.task.body, body);
  assert.deepEqual((await product.task({ id: parent }).read())?.task.needs, [existing]);

  const collision = await product.compose({
    markdown: `+ Parent\nas = fresh\nneeds = @${existing}\n+ Uses fresh\nneeds = ^fresh\n`,
  });
  assert.ok(collision.kind === "accepted");
  const fresh = collision.aliases[0]!.taskId;
  assert.match(fresh, /^task\/parent-[0-9a-f]{4}$/u);
  assert.deepEqual((await product.task({ id: fresh }).read())?.task.needs, [existing]);
  assert.deepEqual((await product.task({ id: collision.admissionOrder[1]! }).read())?.task.needs, [fresh]);

  const edited = await product.compose({
    markdown: `@${parent}\nneeds -= @${existing}\nbody <<BODY\nreplacement\nBODY\n`,
  });
  assert.ok(edited.kind === "accepted");
  const document = (await product.task({ id: parent }).read())!.task;
  assert.deepEqual(document.needs, []);
  assert.equal(document.body, "replacement");
});

test("compose previews without writing and rejects complete planning errors before any admission", async (t) => {
  const product = await fixture(t);
  const preview = await product.compose({
    plan: true,
    markdown: "+ Child\nas = child\nneeds = ^parent\n+ Parent\nas = parent\nbody <<BODY\nbody bytes\nBODY\n",
  });
  assert.ok(preview.kind === "planned");
  const parent = preview.aliases.find(({ alias }) => alias === "parent")!.taskId;
  const child = preview.aliases.find(({ alias }) => alias === "child")!.taskId;
  assert.deepEqual(preview.admissionOrder, [parent, child]);
  assert.equal(preview.bodies[0]?.bytes, 10);
  assert.deepEqual(await rows(product), []);

  const broken = await product.compose({
    markdown: "+ Broken\nas = duplicate\nneeds = @task/missing\n+ Another\nas = duplicate\npri = high\n",
  });
  assert.ok(broken.kind === "refused");
  assert.ok(broken.refusal.diagnostics.length >= 3);
  assert.deepEqual(await rows(product), []);

  const first = await add(product, "First"),
    second = await add(product, "Second");
  const before = await rows(product);
  for (const markdown of [
    `@${first}\nneeds = @${second}\n@${second}\nneeds = @${first}\n`,
    `@${first}\nstate = done\n+ Invalid\nstate += done\n`,
    "+ Invalid\nas = has space\n",
  ]) {
    const result = await product.compose({ markdown });
    assert.ok(result.kind === "refused", markdown);
    assert.deepEqual(await rows(product), before, markdown);
  }
});

test("compose admits the declared initial state of each new node", async (t) => {
  const product = await fixture(t);
  const states = ["in_progress", "on_hold", "done", "drop"] as const;
  const result = await product.compose({
    markdown: states.map((state) => `+ ${state}\nstate = ${state}\n`).join(""),
  });
  assert.ok(result.kind === "accepted");
  assert.deepEqual((await rows(product)).map(({ state }) => state).sort(), [...states].sort());
});

test("busy compose recovery preserves both fenced bytes and non-open initial state", async (t) => {
  const product = await fixture(t);
  const held = await acquireSqliteTransactionLock({
    path: join(product.root, ".keiyaku", "locks", "task-allocation.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  const body = "+ literal\n    indented";
  let result;
  try {
    result = await product.compose({
      markdown: `+ Held\nas = held\nstate = on_hold\nbody <<BODY\n${body}\nBODY\n`,
    });
  } finally {
    held.close();
  }
  assert.ok(result.kind === "incomplete");
  assert.deepEqual(result.stopped, { kind: "retry", reason: "busy" });
  assert.deepEqual(await rows(product), []);
  const replayed = await product.compose({ markdown: result.draft });
  assert.ok(replayed.kind === "accepted");
  const detail = await product.task({ id: replayed.aliases[0]!.taskId }).read();
  assert.equal(detail?.task.body, body);
  assert.equal(detail?.task.state, "on_hold");
  assert.equal((await rows(product)).length, 1);
});

test("empty compose has no admissions or document changes", async (t) => {
  const product = await fixture(t);
  assert.deepEqual(await product.compose({ markdown: "\n" }), {
    kind: "accepted",
    aliases: [],
    admissionOrder: [],
    documentChanges: [],
  });
  assert.deepEqual(await rows(product), []);
});
