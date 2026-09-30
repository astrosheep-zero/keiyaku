import assert from "node:assert/strict";
import test from "node:test";
import type { AkuId } from "../src/akuma/identity.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import type { CallObservation, CallResult } from "../src/library/akuma-creation.js";
import type { WorldRoot } from "../src/world.js";
import { parseArgv } from "../src/cli/parse.js";
import type { ParsedCommandInvocation } from "../src/cli/runtime.js";
import { renderCallText, renderForkText } from "../src/cli/render/akuma.js";
import { callRawAnswer } from "../src/cli/render/akuma-activity.js";
import { AKUMA_ACTIVITY_AT } from "./support/kanshi-activity.js";

const world = "D:\\dev\\repo with $tag\\it's" as WorldRoot;
const akuma = "aku/worker/1234abcd" as AkuId;
const context = { columns: 100, color: false } as const;
function parseExecution(argv: readonly string[]): ParsedCommandInvocation {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

const command = parseExecution(["call", "worker", "prompt"]).command;

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

function detachedCall(result: Pick<CallResult, "dispatch" | "alias">): CallResult {
  return {
    kind: "called",
    akuma,
    execution: { cwd: world, source: "process" },
    observation: { kind: "detached", tell: tellResult() },
    ...result,
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
  const text = renderCallText(detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } }), false, context);
  assert.equal(text, [`${akuma}`, `└─ ${world}`].join("\n"));
  assert.doesNotMatch(text, /^─+$|running|completed/mu, "detached call has no timeline or observation conclusion");
  assert.doesNotMatch(text, /cwd|->|keiyaku wait|to wait|📁/u);
});

test("a contract-bound call receipt hangs contract and cwd as tree branches", () => {
  const text = renderCallText(
    detachedCall({
      dispatch: { kind: "dispatched", dispatch: { contractId: "kei/tree-receipt" } as never },
      alias: { kind: "aliased", alias: { alias: "@sapling" as AkumaAlias, akuId: akuma }, previous: null },
    }),
    false,
    context,
  );
  assert.equal(text, [`${akuma} (@sapling)`, `├─ kei/tree-receipt`, `└─ ${world}`].join("\n"));
});

test("a dispatched fork receipt hangs its contract beneath the child identity", () => {
  const child = "aku/worker/5678abcd" as AkuId;
  const text = renderForkText({
    kind: "forked",
    parent: akuma,
    child,
    dispatch: { kind: "dispatched", dispatch: { contractId: "kei/tree-receipt" } as never },
  });
  assert.equal(text, `${child}\n└─ kei/tree-receipt`);
});

function observingCall(
  observation: CallObservation,
  result: Pick<CallResult, "dispatch" | "alias"> = { dispatch: { kind: "none" }, alias: { kind: "none" } },
): CallResult {
  return {
    kind: "called",
    akuma,
    execution: { cwd: world, source: "process" },
    observation,
    ...result,
  };
}

test("prompt-free call renders its born identity without a Tell receipt", () => {
  const result = observingCall({ kind: "born" });
  const text = renderCallText(result, false, context);
  assert.equal(text, [`${akuma}`, `└─ ${world}`].join("\n"));
  assert.doesNotMatch(text, /tell|answer|cwd|->/u);
});
test("an observing call writes its answer once without repeating cwd or the outcome row", () => {
  const result = observingCall({
    kind: "observed",
    tell: tellResult(),
    observation: { reason: "answered", answer: "final answer" },
  });
  const raw = callRawAnswer(result, true);
  assert.equal(raw, "final answer");
  assert.doesNotMatch(raw ?? "", /cwd/u);
});

test("an observing call keeps a failed observation diagnostic on stdout without cwd", () => {
  const text = renderCallText(
    observingCall({
      kind: "failed",
      tellId: "tell/msys",
      failure: { kind: "infrastructure", diagnostic: "window lost" },
    }),
    false,
    context,
  );
  assert.match(text, /! error window lost/u);
  assert.doesNotMatch(text, /cwd/u);
});

test("detached wait command keeps alias, timeout, failed silence, and JSON", () => {
  const aliased = detachedCall({
    dispatch: { kind: "none" },
    alias: { kind: "aliased", alias: { alias: "@ship" as AkumaAlias, akuId: akuma }, previous: null },
  });
  assert.match(renderCallText(aliased, false, context), /aku\/worker\/1234abcd \(@ship\)/u);

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
    const text = renderCallText(result, false, context);
    assert.ok(text.split("\n").includes(diagnostic));
    assert.doesNotMatch(text, /keiyaku wait|to wait|-----/u);
    }

  const successful = detachedCall({ dispatch: { kind: "none" }, alias: { kind: "none" } });
  assert.match(successful.akuma, /aku\/worker\/1234abcd/u);
});
