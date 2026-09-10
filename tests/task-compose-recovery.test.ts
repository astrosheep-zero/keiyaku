import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSqliteTransactionLock } from "../src/coordination/sqlite-transaction-lock.js";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";

test("compose busy recovery preserves exact body bytes and non-open initial state", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-compose-recovery-"));
  mkdirSync(join(root, ".keiyaku"));
  const tasks = Tasks.of(await World.at(root));
  const held = await acquireSqliteTransactionLock({
    path: join(root, ".keiyaku", "locks", "task-allocation.sqlite"),
    mode: "immediate",
    timeoutMs: 100,
  });
  let result: Awaited<ReturnType<typeof tasks.compose>>;
  try {
    result = await tasks.compose({
      markdown: "+ Held\nas = held\nstate = on_hold\nbody <<BODY\n+ literal\n    indented\nBODY\n",
    });
  } finally {
    held.close();
  }
  assert.equal(result.kind, "incomplete");
  if (result.kind !== "incomplete") return;
  assert.deepEqual(result.stopped, { kind: "retry", reason: "busy" });
  assert.match(result.draft, /state = on_hold/u);
  assert.match(result.draft, /body <<([A-Z_]+)\n\+ literal\n    indented\n\1/u);

  const replayed = await tasks.compose({ markdown: result.draft });
  assert.equal(replayed.kind, "accepted");
  if (replayed.kind !== "accepted") return;
  const taskId = replayed.aliases.find(({ alias }) => alias === "held")?.taskId;
  assert.ok(taskId);
  const detail = await tasks.task({ id: taskId }).read();
  assert.equal(detail?.task.state, "on_hold");
  assert.equal(detail?.task.body, "+ literal\n    indented");
  rmSync(root, { recursive: true, force: true });
});
