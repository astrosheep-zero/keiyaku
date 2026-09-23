import assert from "node:assert/strict";
import test from "node:test";
import type { AkuId } from "../src/akuma/identity.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import type { CallObservation, CallResult } from "../src/library/akuma-creation.js";
import type { WorldRoot } from "../src/world.js";
import { parseArgv, type ParsedExecution } from "../src/cli/parse.js";
import type { AkumaInvocationResult } from "../src/cli/commands/akuma-invoke.js";
import { renderAkumaJson, renderAkumaText } from "../src/cli/render/akuma.js";
import { AKUMA_ACTIVITY_AT } from "./support/kanshi-activity.js";

const world = "D:\\dev\\repo with $tag\\it's" as WorldRoot;
const akuma = "aku/worker/1234abcd" as AkuId;
function parseExecution(argv: readonly string[]): ParsedExecution {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

const command = parseExecution(["call", "worker", "prompt"]).command;
const waitingCommand = parseExecution(["call", "worker", "--wait", "30s", "prompt"]).command;

function tellResult() {
  return {
    admission: { tellId: "tell/msys", fact: "recorded" as const },
    row: {
      kind: "tell" as const,
      sequence: 1,
      at: AKUMA_ACTIVITY_AT,
      tellId: "tell/msys",
      text: "prompt",
      state: "told" as const,
      deliveries: [],
    },
    wake: { kind: "told" as const },
  };
}

function detachedCall(
  result: Pick<CallResult, "dispatch" | "alias">,
): Extract<AkumaInvocationResult, { action: "call" }> {
  return {
    kind: "akuma",
    action: "call",
    world,
    result: {
      kind: "called",
      akuma,
      execution: { cwd: world, source: "process" },
      observation: { kind: "detached", tell: tellResult() },
      ...result,
    },
  };
}

test("call defaults to detached birth and rejects removed detach flags", () => {
  assert.deepEqual(command, {
    command: "call",
    archetype: "worker",
    mode: "detach",
    prompt: { kind: "argument", value: "prompt" },
    output: "text",
  });
  assert.throws(() => parseArgv(["call", "worker", "-d", "prompt"]), /option -d is not valid for call/u);
  assert.throws(() => parseArgv(["call", "worker", "--detach", "prompt"]), /option --detach is not valid for call/u);
  const text = renderAkumaText(command, detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } }));
  assert.match(text, /cwd/u);
  assert.ok(text.split("\n").includes(`  cwd  ${world}`));
  assert.doesNotMatch(text, /keiyaku wait|to wait|-----|📁/u);
});


function observingCall(
  observation: CallObservation,
  result: Pick<CallResult, "dispatch" | "alias"> = { dispatch: { kind: "none" }, alias: { kind: "none" } },
): Extract<AkumaInvocationResult, { action: "call" }> {
  return {
    kind: "akuma",
    action: "call",
    world,
    result: {
      kind: "called",
      akuma,
      execution: { cwd: world, source: "process" },
      observation,
      ...result,
    },
  };
}

test("an observing call writes its answer once without repeating cwd or the outcome row", () => {
  const text = renderAkumaText(
    waitingCommand,
    observingCall({ kind: "observed", tell: tellResult(), observation: { reason: "answered", answer: "final answer" } }),
  );
  assert.equal(text, "final answer");
  assert.doesNotMatch(text, /cwd/u);
});

test("an observing call keeps a failed observation diagnostic on stdout without cwd", () => {
  const text = renderAkumaText(
    waitingCommand,
    observingCall({
      kind: "failed",
      tellId: "tell/msys",
      failure: { kind: "infrastructure", diagnostic: "window lost" },
    }),
  );
  assert.match(text, /! error window lost/u);
  assert.doesNotMatch(text, /cwd/u);
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
