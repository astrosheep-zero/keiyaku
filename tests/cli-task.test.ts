import assert from "node:assert/strict";
import test from "node:test";
import { CliUsageError, parseArgv } from "../src/cli/parse.js";

test("task stdin markers stay exclusive and position independent", () => {
  assert.deepEqual(parseArgv(["task", "add", "-", "--namespace", "contract/inside", "--actor", "flagship"]), {
    command: {
      command: "task",
      action: "add",
      output: "text",
      positionals: [],
      flags: { namespace: "contract/inside", actor: "flagship" },
      stdin: "document",
    },
  });
  assert.deepEqual(parseArgv(["task", "compose", "-", "--actor", "flagship", "--json"]), {
    command: {
      command: "task",
      action: "compose",
      output: "json",
      positionals: [],
      flags: { actor: "flagship", json: true },
      stdin: "compose",
    },
  });
  assert.deepEqual(parseArgv(["task", "update", "task/a", "--body", "-", "--priority", "1"]), {
    command: {
      command: "task",
      action: "update",
      output: "text",
      positionals: ["task/a"],
      flags: { body: "", priority: "1" },
      stdin: "body",
    },
  });
  assert.throws(() => parseArgv(["task", "update", "task/a", "--append", "-", "--json"]), /--append requires a value/u);
  assert.throws(() => parseArgv(["task", "update", "task/a", "--note", "-", "--title", "Renamed"]), /--note requires a value/u);
  assert.throws(() => parseArgv(["task", "update", "task/a", "--body", "-", "--note", "-"]), /--note requires a value/u);
  assert.throws(() => parseArgv(["task", "add", "-", "-"]), /stdin marker '-' may appear only once/u);
  assert.throws(() => parseArgv(["task", "update", "task/a", "--title", "-"]), /--title requires a value/u);
  assert.throws(() => parseArgv(["task", "update", "task/a", "--parent", "-"]), /--parent requires a value/u);
  assert.throws(() => parseArgv(["task", "ls", "-"]), /stdin marker '-' is not valid here/u);
  assert.throws(() => parseArgv(["task", "compose"]), /task compose requires '-' input/u);
  assert.throws(
    () => parseArgv(["task", "add"]),
    (error: unknown) => error instanceof CliUsageError && /task add requires either TITLE or '-' input/.test(error.message),
  );
});
