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
    settlement: { actions: [], lags: [] },
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

test("bind retry text has no contract segment", () => {
  const result: InvocationResult = {
    kind: "retry",
    verb: "bind",
    detail: { kind: "exhausted" },
  };

  assert.equal(renderText(result), 'retry bind {"kind":"exhausted"}');
  assert.equal("contract" in result, false);
});

test("addressed retry text retains its caller coordinate", () => {
  const contract = contractId("kei/render-retry");
  const result: InvocationResult = {
    kind: "retry",
    verb: "amend",
    contract,
    detail: { kind: "exhausted" },
  };

  assert.equal(renderText(result), 'retry amend kei/render-retry {"kind":"exhausted"}');
});

test("accepted text preserves named obligation stops after facts", () => {
  const contract = contractId("kei/render-steps");
  const result: InvocationResult = {
    kind: "accepted",
    verb: "deliver",
    contract,
    head: null,
    facts: [{ contract, entry: "01J00000000000000000000000", kind: "deliver" }],
    verification: { refusal: { kind: "terminal", contractId: contract } },
    placement: { retry: { kind: "exhausted" } },
    leak: { path: "/tmp/keiyaku-v4-verify-leak", diagnostic: "worktree remove failed" },
    effects: [{ kind: "ref", name: "refs/heads/main", action: "unchanged", before: null, after: null }],
    settlement: { actions: [], lags: [] },
  };

  assert.equal(renderText(result), [
    `accepted deliver ${contract} head=null`,
    `fact ${contract} 01J00000000000000000000000 deliver`,
    `stop verification {"refusal":{"kind":"terminal","contractId":"kei/render-steps"}}`,
    `stop placement {"retry":{"kind":"exhausted"}}`,
    "leak worktree /tmp/keiyaku-v4-verify-leak worktree remove failed",
    "effect ref unchanged refs/heads/main null -> null",
  ].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("accepted text renders Region witnesses and unavailable observations", () => {
  const contract = contractId("kei/render-region");
  const witnesses: InvocationResult = {
    kind: "accepted",
    verb: "bind",
    contract,
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    target: "refs/heads/main",
    overlaps: [{
      contract: contractId("kei/peer"),
      patterns: [
        { mine: "src/**", theirs: "src/api/**" },
        { mine: "docs/**", theirs: "docs/**" },
      ],
    }],
  };
  assert.equal(renderText(witnesses), [
    `accepted bind ${contract} head=null`,
    "target refs/heads/main",
    "overlap kei/peer src/** ~ src/api/**",
    "overlap kei/peer docs/** ~ docs/**",
  ].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(witnesses)), witnesses);

  const unavailable: InvocationResult = {
    kind: "accepted",
    verb: "amend",
    contract,
    head: null,
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    overlapFailure: "kei/peer: malformed document",
  };
  assert.equal(renderText(unavailable), [
    `accepted amend ${contract} head=null`,
    "overlap unavailable kei/peer: malformed document",
  ].join("\n"));
  assert.deepEqual(JSON.parse(JSON.stringify(unavailable)), unavailable);
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), 'observation status\n{\n  "contracts": []\n}');
});
