import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { Tasks } from "../src/task/index.js";
import { World } from "../src/world.js";

test("repository Task authority is readable by the current hard-cut codec", async () => {
  const tasks = Tasks.of(World.at(resolve(import.meta.dirname, "..")));
  const result = await tasks.list({ selection: "all", scope: "world" });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.ok(result.value.rows.length > 0);
  assert.ok(result.value.rows.every((task) => task.id.startsWith("task/")));
});
