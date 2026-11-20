import assert from "node:assert/strict";
import test from "node:test";
import { parseAkumaId, type AkumaId } from "../src/akuma/identity.js";
import type { SpawnResult } from "../src/library/akuma-creation.js";
import type { WorldRoot } from "../src/world.js";
import { renderCallText } from "../src/cli/render/akuma.js";
import { contractId } from "../src/core/facts/types.js";

const world = "D:\\dev\\repo with $tag\\it's" as WorldRoot;
const akuma = "aku/worker/1234abcd" as AkumaId;
function spawned(extra: Omit<Extract<SpawnResult, { kind: "spawned" }>, "kind" | "akumaId"> | Omit<Extract<SpawnResult, { kind: "failed" }>, "akumaId"> = {}): SpawnResult {
  return { kind: "spawned", akumaId: akuma, ...extra };
}

test("a contract-bound spawn receipt indents contract, invocation context, and alias displacement alike", () => {
  const previous = parseAkumaId("aku/worker/0000beef").id;
  const text = renderCallText(
    spawned({ alias: { kind: "moved", previousAkumaId: previous } }),
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

test("a detached call keeps its born child, execution directory, and native failure evidence", () => {
  const text = renderCallText(
    spawned({
      tellId: "tell/msys",
      kind: "failed", failures: [{ stage: "tell", kind: "infrastructure", diagnostic: "window lost" }],
    }),
    { cwd: world, prompt: "prompt" },
  );
  assert.equal(
    text,
    [
      `! ${akuma} born · tell failed · do not respawn`,
      `  ${world}`,
      "  input tell/msys admitted",
      "  prompt",
      "  ! tell failed infrastructure window lost",
    ].join("\n"),
    "a failed Tell stage stays an action receipt over the admitted child, its directory, and its Tell input",
  );
  assert.equal((text.match(/^  prompt$/gmu) ?? []).length, 1, "the submitted Tell payload is not replayed");
});
