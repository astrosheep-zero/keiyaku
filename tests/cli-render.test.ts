import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderText } from "../src/cli/render/text.js";

test("accepted text keeps facts before observed effect facts", () => {
  const contract = contractId("kei/render-effect");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head: "0123456789abcdef0123456789abcdef01234567",
    facts: [{ contract, entry: "01J00000000000000000000000", kind: "deliver" }],
    effects: [{
      kind: "ref",
      name: "refs/heads/main",
      action: "updated",
      before: "1111111111111111111111111111111111111111",
      after: "2222222222222222222222222222222222222222",
    }],
  };

  assert.equal(renderText(result), [
    "accepted deliver kei/render-effect head=0123456789abcdef0123456789abcdef01234567",
    "fact kei/render-effect 01J00000000000000000000000 deliver",
    "effect ref updated refs/heads/main 1111111111111111111111111111111111111111 -> 2222222222222222222222222222222222222222",
  ].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("typed refusal text preserves the refusal object", () => {
  const contract = contractId("kei/render-refusal");
  const result: InvocationResult = {
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: { kind: "candidate-not-based-on-target", contractId: contract },
  };

  assert.equal(
    renderText(result),
    'refused deliver kei/render-refusal {"kind":"candidate-not-based-on-target","contractId":"kei/render-refusal"}',
  );
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), 'observation status\n{\n  "contracts": []\n}');
});
