import assert from "node:assert/strict";
import test from "node:test";
import { contractHead, contractId, snapshotId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import { renderText } from "../src/cli/render/text.js";

test("guidance text is the exact Markdown projection", () => {
  const guidance = "---\ncontract: kei/show\n---\n\n# Show\n";
  assert.equal(renderText({ kind: "guidance", contract: contractId("kei/show"), guidance }), guidance);
});

test("catalog text renders only the selected identity layer", () => {
  assert.equal(renderCatalogText({
    kind: "archetypes",
    rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
  }), [
    "reviewer - codex-5",
    "  Read the complete change without truncation.",
  ].join("\n"));
  assert.equal(renderCatalogText({
    kind: "akuma",
    root: "/world",
    archetype: "worker",
    rows: [{ id: "aku/worker/deadbeef" as never, life: "unborn" }],
    searched: ["/world/.keiyaku/akuma/run"],
  }), "aku/worker/deadbeef - unborn");
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), 'observation status\n{\n  "contracts": []\n}');
});

test("completion stops render the public unmet prerequisites in order", () => {
  const contract = contractId("kei/waiting-on-prerequisites");
  const unmet = [
    { contractId: contractId("kei/active-prerequisite"), state: "active" as const },
    { contractId: contractId("kei/abandoned-prerequisite"), state: "abandoned" as const },
    { contractId: contractId("kei/missing-prerequisite"), state: "missing" as const },
  ];
  const placement = {
    refusal: { kind: "prerequisites-unsatisfied" as const, contractId: contract, unmet },
  };
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
  };

  const deliver: InvocationResult = { ...envelope, verb: "deliver", placement };
  assert.equal(renderText(deliver), [
    "✓ deliver — not complete — kei/waiting-on-prerequisites",
    "  candidate kept",
    "! completion blocked · prerequisites-unsatisfied",
    "  prerequisite kei/active-prerequisite · active",
    "  prerequisite kei/abandoned-prerequisite · abandoned",
    "  prerequisite kei/missing-prerequisite · missing",
    "  record",
    "    head head",
  ].join("\n"));

  const review: InvocationResult = { ...envelope, verb: "review", verdict: "satisfied", placement };
  assert.equal(renderText(review), [
    "✓ review satisfied — kei/waiting-on-prerequisites",
    "! contract not complete",
    "! completion blocked · prerequisites-unsatisfied",
    "  prerequisite kei/active-prerequisite · active",
    "  prerequisite kei/abandoned-prerequisite · abandoned",
    "  prerequisite kei/missing-prerequisite · missing",
    "  record",
    "    head head",
  ].join("\n"));
});

test("reintegration receipts show the new target and a bounded movement stop", () => {
  const contract = contractId("kei/reintegrated");
  const predecessor = snapshotId("target-1");
  const integrated = snapshotId("integration-2");
  const observed = snapshotId("target-3");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  const facts = [{
    contract,
    entry: "reintegration",
    kind: "reintegrated" as const,
    data: { predecessor, snapshot: integrated },
  }];

  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    facts: [...facts, { contract, entry: "claim", kind: "claimed" as const }],
    verificationVerdict: "satisfied",
  }), [
    "✓ delivered — kei/reintegrated",
    "  re-integrated target-1 -> integration-2",
    "  verification re-run · satisfied",
    "  target -> integration-2",
    "✓ verification passed",
    "  record",
    "    journal reintegration · reintegrated",
    "    journal claim · claimed",
    "    head head",
  ].join("\n"));

  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    facts,
    placement: {
      failure: "target-moved",
      contractId: contract,
      target: "refs/heads/main",
      integratedAt: integrated,
      observed: null,
      attempts: 3,
    },
  }), [
    "✓ deliver — not complete — kei/reintegrated",
    "  re-integrated target-1 -> integration-2",
    "  candidate kept",
    "! completion blocked · target-moved refs/heads/main integration-2 -> null",
    "  attempts=3",
    "  record",
    "    journal reintegration · reintegrated",
    "    head head",
  ].join("\n"));
});
