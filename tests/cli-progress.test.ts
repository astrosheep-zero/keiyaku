import assert from "node:assert/strict";
import test from "node:test";
import { invocationStart } from "../src/cli/runtime.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv, type ParsedCommand } from "../src/cli/parse.js";

function command(argv: readonly string[]): ParsedCommand {
  const parsed = parseArgv(argv);
  if ("help" in parsed) throw new Error("expected an executable command");
  return parsed.command;
}

test("opaque text operations announce their work without covering explicit waits", () => {
  assert.equal(invocationStart(command(["bind", "-"])), "⧖ preparing keiyaku");
  assert.equal(invocationStart(command(["deliver", "kei/example"])), "⧖ delivering");
  assert.equal(invocationStart(command(["audit", "kei/example"])), "⧖ auditing");
  assert.equal(invocationStart(command(["reconcile"])), "⧖ reconciling");
  assert.equal(invocationStart(command(["install", "codex"])), "⧖ installing harness integrations");

  assert.equal(invocationStart(command(["wait", "aku/codex/12345678", "--timeout", "5m"])), undefined);
  assert.equal(invocationStart(command(["call", "codex", "work"])), undefined);
  assert.equal(invocationStart(command(["status"])), undefined);
});

test("JSON operations never announce work", () => {
  assert.equal(invocationStart(command(["bind", "--json", "-"])), undefined);
  assert.equal(invocationStart(command(["deliver", "kei/example", "--json"])), undefined);
  assert.equal(invocationStart(command(["audit", "kei/example", "--json"])), undefined);
  assert.equal(invocationStart(command(["reconcile", "--json"])), undefined);
  assert.equal(invocationStart(command(["install", "codex", "--json"])), undefined);
});

test("an operation starts only after selected stdin is fully acquired", async () => {
  const events: string[] = [];
  const parsed = parseArgv(["-C", "/definitely/absent/keiyaku-progress-test", "bind", "-"]);
  if (!("command" in parsed)) throw new Error("expected an executable command");
  await assert.rejects(
    invoke(parsed, {
      readStdin: async () => {
        events.push("stdin");
        return "contract document";
      },
      onOperationStart: () => {
        events.push("start");
      },
    }),
  );
  assert.deepEqual(events, ["stdin", "start"]);
});
