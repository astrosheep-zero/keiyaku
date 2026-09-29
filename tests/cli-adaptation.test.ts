import { temporaryDirectory } from "./support/process.js";
import { executable } from "./support/cli-fixtures.js";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { invoke as invokeRaw } from "../src/cli/invoke.js";

test("Task CLI adapts a successful mutation and read", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-task-cli-adaptation-");
  mkdirSync(join(root, ".keiyaku"));
  const added = (await invokeRaw(executable(["-C", root, "task", "add", "CLI task", "--note", "created"]))) as unknown as {
    kind: string;
    value: { id: string };
  };
  assert.ok(added.kind === "accepted", "expected added.kind = \"accepted\"");

  const shown = (await invokeRaw(executable(["-C", root, "task", "show", added.value.id]))) as {
    task: { title: string; note: string };
  };
  assert.equal(shown.task.title, "CLI task");
  assert.equal(shown.task.note, "created");
});
