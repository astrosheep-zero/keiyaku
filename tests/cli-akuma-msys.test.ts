import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import type { AkuId } from "../src/akuma/identity.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import type { CallResult } from "../src/library/akuma-creation.js";
import type { WorldRoot } from "../src/world.js";
import { parseArgv, type ParsedExecution } from "../src/cli/parse.js";
import type { AkumaInvocationResult } from "../src/cli/commands/akuma-invoke.js";
import { renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";

const world = "D:\\dev\\repo with $tag\\it's" as WorldRoot;
const akuma = "aku/worker/1234abcd" as AkuId;
function parseExecution(argv: readonly string[]): ParsedExecution {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

const command = parseExecution(["call", "worker", "-d", "prompt"]).command;

function detachedCall(result: Pick<CallResult, "dispatch" | "alias">): Extract<AkumaInvocationResult, { action: "call" }> {
  return {
    kind: "akuma",
    action: "call",
    world,
    result: {
      kind: "called",
      akuma,
      execution: { cwd: world, source: "process" },
      observation: { kind: "detached" },
      ...result,
    },
  };
}

function renderedWait(result: Parameters<typeof renderAkumaText>[1]): string {
  return renderAkumaText(command, result).split("\n").at(-1)!;
}

function posixArgv(line: string): string[] {
  const parsed = spawnSync("bash", ["-c", `set -- ${line.slice(2)}; printf '%s\\0' "$@"`], { encoding: "utf8" });
  assert.equal(parsed.status, 0, parsed.stderr);
  return parsed.stdout.split("\0").slice(0, -1);
}

test("detached wait command preserves a Windows World through POSIX shell parsing", () => {
  const argv = posixArgv(renderedWait(detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } })));
  assert.deepEqual(argv, ["keiyaku", "-C", world, "wait", akuma, "--timeout", "5m"]);
});

test("detached wait command keeps alias, timeout, failed silence, and JSON", () => {
  const aliased = detachedCall({
    dispatch: { kind: "none" },
    alias: { kind: "aliased", alias: { alias: "@ship" as AkumaAlias, akuId: akuma }, previous: null },
  });
  assert.deepEqual(posixArgv(renderedWait(aliased)), ["keiyaku", "-C", world, "wait", "@ship", "--timeout", "5m"]);

  const failed = detachedCall({
    dispatch: { kind: "failed", failure: { kind: "infrastructure", diagnostic: "busy" } },
    alias: { kind: "skipped", reason: "dispatch-failed" },
  });
  assert.doesNotMatch(renderAkumaText(command, failed), /\$ keiyaku /u);
  assert.equal(renderAkumaJson(failed), JSON.stringify(failed.result));

  const successful = detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } });
  assert.equal(renderAkumaJson(successful), JSON.stringify(successful.result));
});
