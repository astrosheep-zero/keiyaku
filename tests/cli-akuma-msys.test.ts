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

function detachedCall(
  result: Pick<CallResult, "dispatch" | "alias" | "readonly">,
): Extract<AkumaInvocationResult, { action: "call" }> {
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

function posixArgv(line: string): string[] {
  const parsed = spawnSync("bash", ["-c", `set -- ${line.slice("$ ".length)}; printf '%s\\0' "$@"`], {
    encoding: "utf8",
  });
  assert.equal(parsed.status, 0, parsed.stderr);
  return parsed.stdout.split("\0").slice(0, -1);
}

test("detached wait keeps Windows cwd separate from its POSIX-copyable handle", () => {
  const result = detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } });
  const text = renderAkumaText(command, result);
  assert.ok(text.split("\n").includes(`  cwd  ${world}`));
  assert.doesNotMatch(text, /keiyaku wait|to wait|-----|📁/u);
});

test("detached wait command keeps alias, timeout, failed silence, and JSON", () => {
  const aliased = detachedCall({
    dispatch: { kind: "none" },
    alias: { kind: "aliased", alias: { alias: "@ship" as AkumaAlias, akuId: akuma }, previous: null },
  });
  assert.match(renderAkumaText(command, aliased), /aku\/worker\/1234abcd \(@ship\)/u);

  const failures = [
    {
      result: detachedCall({
        dispatch: { kind: "failed", failure: { kind: "infrastructure", diagnostic: "busy" } },
        alias: { kind: "skipped", reason: "dispatch-failed" },
      }),
      diagnostic: "dispatch failed infrastructure busy",
    },
    {
      result: detachedCall({
        dispatch: { kind: "none" },
        alias: { kind: "failed", failure: { kind: "infrastructure", diagnostic: "locked" } },
      }),
      diagnostic: "alias failed infrastructure locked",
    },
    {
      result: detachedCall({
        dispatch: { kind: "none" },
        alias: { kind: "none" },
        readonly: { enforcement: "none", diagnostic: "readonly unsupported" },
      }),
      diagnostic: "! readonly unsupported",
    },
  ];
  for (const { result, diagnostic } of failures) {
    const text = renderAkumaText(command, result);
    assert.ok(text.split("\n").includes(diagnostic));
    assert.doesNotMatch(text, /keiyaku wait|to wait|-----/u);
    assert.equal(renderAkumaJson(result), JSON.stringify(result.result));
  }

  const successful = detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } });
  assert.equal(renderAkumaJson(successful), JSON.stringify(successful.result));
});
