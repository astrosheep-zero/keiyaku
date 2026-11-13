import assert from "node:assert/strict";
import test from "node:test";
import { parseAkumaId, type AkumaId } from "../src/akuma/identity.js";
import type { SpawnResult } from "../src/library/akuma-creation.js";
import type { WorldRoot } from "../src/world.js";
import { parseArgv } from "../src/cli/parse.js";
import type { ParsedCommandInvocation } from "../src/cli/runtime.js";
import { renderCallText, renderForkText } from "../src/cli/render/akuma.js";
import { contractId } from "../src/core/facts/types.js";
import { callRawAnswer } from "../src/cli/render/akuma-activity.js";

const world = "D:\\dev\\repo with $tag\\it's" as WorldRoot;
const akuma = "aku/worker/1234abcd" as AkumaId;
const context = { columns: 100, color: false } as const;
function parseExecution(argv: readonly string[]): ParsedCommandInvocation {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected command invocation");
  return parsed;
}

const command = parseExecution(["spawn", "worker", "prompt"]).command;

function spawned(extra: Omit<Extract<SpawnResult, { kind: "spawned" }>, "kind" | "akumaId"> | Omit<Extract<SpawnResult, { kind: "failed" }>, "akumaId"> = {}): SpawnResult {
  return { kind: "spawned", akumaId: akuma, ...extra };
}

test("spawn defaults to detached birth and rejects removed detach flags", () => {
  assert.deepEqual(command, {
    name: "spawn",
    input: { akumaName: "worker" },
    acquire: { prompt: { kind: "argument", value: "prompt" } },
    output: "text",
  });
  assert.throws(() => parseArgv(["spawn", "worker", "-d", "prompt"]), /option -d is not valid for spawn/u);
  assert.throws(() => parseArgv(["spawn", "worker", "--detach", "prompt"]), /option --detach is not valid for spawn/u);
  const text = renderCallText(spawned(), false, context, { cwd: world });
  assert.equal(text, [`✓ spawned ${akuma}`, `  ${world}`].join("\n"), "verdict, subject, and invocation directory");
  assert.doesNotMatch(text, /^─+$|running|completed/mu, "detached spawn has no timeline or observation conclusion");
  assert.doesNotMatch(text, /cwd|->|keiyaku wait|to wait|📁|└─|├─/u);
});

test("a contract-bound spawn receipt indents contract, invocation context, and alias displacement alike", () => {
  const previous = parseAkumaId("aku/worker/0000beef").id;
  const text = renderCallText(
    spawned({ alias: { kind: "moved", previousAkumaId: previous } }),
    false,
    context,
    { cwd: world, contractId: contractId("kei/tree-receipt"), alias: "@sapling" },
  );
  assert.equal(
    text,
    [
      `✓ spawned ${akuma} (@sapling)`,
      "  kei/tree-receipt",
      `  ${world}`,
      `  alias moved · previous ${previous}`,
    ].join("\n"),
    "the alias stays on the subject line and no fact kind collapses into a tree",
  );
});

test("a fork receipt names its source without inventing extra evidence", () => {
  const child = "aku/worker/5678abcd" as AkumaId;
  const text = renderForkText({ kind: "forked", childAkumaId: child, parentAkumaId: akuma }, { akuma, at: "turn/1" });
  assert.equal(text, [`✓ forked ${child}`, `  from ${akuma}`].join("\n"));
});

test("prompt-free spawn renders its born identity without a Tell receipt", () => {
  const result = spawned();
  const text = renderCallText(result, false, context, { cwd: world });
  assert.equal(text, [`✓ spawned ${akuma}`, `  ${world}`].join("\n"));
  assert.doesNotMatch(text, /tell|answer|cwd|->/u);
});

test("an observing call writes its answer once without repeating cwd or the outcome row", () => {
  const result = spawned({
    tellId: "tell/msys",
    input: { kind: "answered", answer: "final answer" },
  });
  const raw = callRawAnswer(result, false);
  assert.equal(raw, "final answer");
  assert.doesNotMatch(raw ?? "", /cwd/u);
});

test("a detached call keeps its born child, execution directory, and native failure evidence", () => {
  const text = renderCallText(
    spawned({
      tellId: "tell/msys",
      kind: "failed", failures: [{ stage: "tell", kind: "infrastructure", diagnostic: "window lost" }],
    }),
    false,
    context,
    { cwd: world, prompt: "prompt" },
  );
  assert.equal(
    text,
    [
      `! spawned ${akuma}`,
      `  ${world}`,
      "  input tell/msys",
      '  "prompt"',
      "  ! tell failed infrastructure window lost",
    ].join("\n"),
    "a failed Tell stage stays an action receipt over the admitted child, its directory, and its Tell input",
  );
  assert.equal((text.match(/"prompt"/gu) ?? []).length, 1, "the submitted Tell payload is not replayed");
});

test("detached spawn keeps alias and independent partial failures", () => {
  const aliased = spawned();
  assert.match(
    renderCallText(aliased, false, context, { cwd: world, alias: "@ship" }),
    /aku\/worker\/1234abcd \(@ship\)/u,
  );

  const failures = [
    {
      result: spawned({ kind: "failed", failures: [{ stage: "dispatch", failure: { kind: "infrastructure", diagnostic: "busy" } }] }),
      diagnostic: "! dispatch failed infrastructure busy",
    },
    {
      result: spawned({ kind: "failed", failures: [{ stage: "alias", kind: "infrastructure", diagnostic: "locked" }] }),
      diagnostic: "! alias failed infrastructure locked",
    },
  ];
  for (const { result, diagnostic } of failures) {
    const text = renderCallText(result, false, context, { cwd: world });
    assert.ok(text.split("\n").includes(`  ${diagnostic}`), diagnostic);
    assert.match(
      text.split("\n")[0]!,
      /^! spawned aku\/worker\/1234abcd/u,
      "a partial failure is marked on the verdict",
    );
    assert.doesNotMatch(text, /keiyaku wait|to wait|-----/u);
  }

  const successful = spawned();
  assert.match(successful.akumaId, /aku\/worker\/1234abcd/u);
});
