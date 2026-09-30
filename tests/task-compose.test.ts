import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Tasks } from "../src/task/index.js";
import { taskMutationRequestProtocol } from "../src/task/mutation.js";
import {
  taskCompositionResultSchema,
  taskRefusalSchema,
  taskMutationResultSchema,
  taskUpdateResultSchema,
} from "../src/task/mutation-result.js";
import type { TaskCompositionFacts, TaskDocumentChange } from "../src/task/compose.js";
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
  assert.deepEqual(preview.aliases, [
    { alias: "child", position: 1 },
    { alias: "parent", position: 2 },
  ]);
  assert.deepEqual(preview.admissionOrder, [
    { position: 2, alias: "parent" },
    { position: 1, alias: "child" },
  ]);
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
    admissions: [],
    documentChanges: [],
  });
  assert.deepEqual(await rows(product), []);
});

test("actual composition results round-trip the Task wire reader without losing projected nested facts", async (t) => {
  const product = await fixture(t);
  const protocol = taskMutationRequestProtocol("task.compose");
  const markdown = "+ Parent\nas = parent\nbody <<BODY\nfirst\nlast\nBODY\n+ Child\nneeds = ^parent\n";
  const plan = await product.compose({ markdown, plan: true });
  assert.ok(plan.kind === "planned");
  assert.deepEqual(protocol.decodeResult(JSON.parse(JSON.stringify(plan))), plan);
  assert.equal(plan.bodies[0]?.firstLine, "first");
  assert.equal(plan.bodies[0]?.lastLine, "last");
  const optionalOrder = { ...plan, admissionOrder: [{ position: 1, alias: undefined, taskId: undefined }] };
  assert.deepEqual(protocol.decodeResult(optionalOrder), optionalOrder);

  const accepted = await product.compose({ markdown });
  assert.ok(accepted.kind === "accepted");
  const facts: TaskCompositionFacts = accepted;
  const change: TaskDocumentChange = accepted.documentChanges[0]!;
  assert.equal(facts.aliases[0]?.taskId, change.taskId);
  assert.deepEqual(protocol.decodeResult(JSON.parse(JSON.stringify(accepted))), accepted);
  assert.deepEqual(protocol.decodeResult({ ...accepted, cleanup: undefined }), accepted);
  const incomplete = {
    ...accepted,
    kind: "incomplete",
    stopped: { kind: "retry", reason: "busy" },
    draft: "+ Remaining\n",
  };
  assert.deepEqual(protocol.decodeResult(JSON.parse(JSON.stringify(incomplete))), incomplete);

  const refused = await product.compose({ markdown: "+ Broken\nneeds = @task/missing\n" });
  assert.ok(refused.kind === "refused");
  assert.deepEqual(protocol.decodeResult(JSON.parse(JSON.stringify(refused))), refused);
  assert.throws(
    () => protocol.decodeResult({ ...refused, refusal: { kind: "invalid-composition" } }),
    /transport integrity/,
  );
  assert.throws(
    () => protocol.decodeResult({ ...refused, refusal: { ...refused.refusal, foreign: undefined } }),
    /transport integrity/,
  );
  assert.throws(
    () =>
      protocol.decodeResult({
        ...refused,
        refusal: { kind: "invalid-composition", diagnostics: [{ line: 1, reason: "missing token" }] },
      }),
    /transport integrity/,
  );
  assert.throws(
    () => protocol.decodeResult({ ...accepted, aliases: [{ alias: "parent", taskId: "task/Bad" }] }),
    /transport integrity/,
  );
  assert.throws(
    () => protocol.decodeResult({ ...plan, bodies: [{ ...plan.bodies[0], bytes: -1 }] }),
    /transport integrity/,
  );
});

test("composition and ordinary Task results share their actual refusal schema objects", () => {
  assert.equal(taskCompositionResultSchema.options[2].shape.refusal, taskRefusalSchema.options[5]);
  assert.equal(taskMutationResultSchema.options[1], taskUpdateResultSchema.options[1]);
});
