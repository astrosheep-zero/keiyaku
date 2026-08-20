import assert from "node:assert/strict";
import test from "node:test";
import { contractHead, contractId, snapshotId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import { renderText } from "../src/cli/render/text.js";

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

test("world reconcile text keeps a completed report under report", () => {
  const result: InvocationResult = {
    kind: "observation",
    command: "reconcile",
    report: { kind: "completed", contracts: [] },
  };
  assert.equal(renderText(result), [
    "observation reconcile",
    "{",
    '  "report": {',
    '    "kind": "completed",',
    '    "contracts": []',
    "  }",
    "}",
  ].join("\n"));
});

test("world observation failure text is exact", () => {
  const result: InvocationResult = {
    kind: "observation",
    command: "reconcile",
    report: { kind: "world-observation-failed", diagnostic: "git failed" },
  };
  assert.equal(renderText(result), "reconcile: world observation failed · git failed");
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
    "✓ review satisfied — not complete — kei/waiting-on-prerequisites",
    "  candidate kept",
    "! completion blocked · prerequisites-unsatisfied",
    "  prerequisite kei/active-prerequisite · active",
    "  prerequisite kei/abandoned-prerequisite · abandoned",
    "  prerequisite kei/missing-prerequisite · missing",
    "  record",
    "    head head",
  ].join("\n"));
});

test("deliver projects a ran Verification completion", () => {
  const contract = contractId("kei/completion");
  const integration = snapshotId("integration-1");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    completion: { integration, verification: { mode: "ran", verdict: "satisfied" } },
  }), [
    "✓ delivered — kei/completion",
    "  target -> integration-1 · verified (ran)",
    "  record",
    "    journal claim · claimed",
    "    head head",
  ].join("\n"));
});

test("deliver renders claimed and stopped continuations from the accepted result", () => {
  const contract = contractId("kei/prerequisite");
  const claimed = contractId("kei/claimed-dependent");
  const stopped = contractId("kei/stopped-dependent");
  assert.equal(renderText({
    kind: "accepted",
    verb: "deliver",
    contract,
    head: contractHead("head"),
    facts: [],
    effects: [],
    settlement: { actions: [], lags: [] },
    completion: { integration: snapshotId("integration") },
    continuation: {
      attempted: 2,
      claimed: [claimed],
      stopped: [{
        contractId: stopped,
        stop: { refusal: { kind: "gates-unsatisfied", contractId: stopped } },
      }],
    },
  }), [
    "✓ delivered — kei/prerequisite",
    "  target -> integration",
    "✓ continuation complete kei/claimed-dependent",
    "! continuation blocked kei/stopped-dependent · gates-unsatisfied",
    "  record",
    "    head head",
  ].join("\n"));
});

test("deliver projects no Verification and an unsatisfied non-gating Verification", () => {
  const contract = contractId("kei/completion-states");
  const integration = snapshotId("integration-2");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    completion: { integration },
  }), [
    "✓ delivered — kei/completion-states",
    "  target -> integration-2",
    "  record",
    "    journal claim · claimed",
    "    head head",
  ].join("\n"));

  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    completion: { integration, verification: { mode: "ran", verdict: "unsatisfied" } },
    verificationSummary: "[1 bash exit 1]",
  }), [
    "✓ delivered — kei/completion-states",
    "  target -> integration-2",
    "! verification unsatisfied (ran)",
    "  summary",
    "",
    "[1 bash exit 1]",
    "",
    "  record",
    "    journal claim · claimed",
    "    head head",
  ].join("\n"));
});

test("review projects reused Verification and distinguishes completion in its title", () => {
  const contract = contractId("kei/review-completion");
  const integration = snapshotId("integration-3");
  const envelope = {
    kind: "accepted" as const,
    contract,
    head: contractHead("head"),
    facts: [{ contract, entry: "claim", kind: "claimed" as const }],
    effects: [],
    settlement: { actions: [], lags: [] },
  };
  assert.equal(renderText({
    ...envelope,
    verb: "review",
    verdict: "satisfied",
    completion: { integration, verification: { mode: "reused", verdict: "satisfied" } },
  }), [
    "✓ review satisfied — complete — kei/review-completion",
    "  target -> integration-3 · verified (reused)",
    "  record",
    "    journal claim · claimed",
    "    head head",
  ].join("\n"));
});

test("movement projects its deviation and reintegration coordinates", () => {
  const contract = contractId("kei/reintegrated");
  const predecessor = snapshotId("target-1");
  const integrated = snapshotId("integration-2");
  const secondPredecessor = snapshotId("target-3");
  const secondIntegrated = snapshotId("integration-4");
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
  }, {
    contract,
    entry: "reintegration-2",
    kind: "reintegrated" as const,
    data: { predecessor: secondPredecessor, snapshot: secondIntegrated },
  }, { contract, entry: "claim", kind: "claimed" as const }];

  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    facts,
    completion: { integration: secondIntegrated },
  }), [
    "✓ delivered — kei/reintegrated",
    "~ target moved · re-integrated x2",
    "  target -> integration-4",
    "  record",
    "    journal reintegration · reintegrated target-1 -> integration-2",
    "    journal reintegration-2 · reintegrated target-3 -> integration-4",
    "    journal claim · claimed",
    "    head head",
  ].join("\n"));

  assert.equal(renderText({
    ...envelope,
    verb: "deliver",
    facts: facts.slice(0, 2),
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
    "~ target moved · re-integrated x2",
    "  candidate kept",
    "! completion blocked · target-moved refs/heads/main integration-2 -> null",
    "  attempts=3",
    "  record",
    "    journal reintegration · reintegrated target-1 -> integration-2",
    "    journal reintegration-2 · reintegrated target-3 -> integration-4",
    "    head head",
  ].join("\n"));
});

test("deliver conflict text exposes target head, paths, and recovery", () => {
  const contract = contractId("kei/conflicted");
  const targetHead = snapshotId("target-head");
  assert.equal(renderText({
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: {
      kind: "integration-failed",
      contractId: contract,
      reason: "conflict",
      targetHead,
      conflictPaths: ["a.txt", "z.txt"],
      recovery: { materialize: "deliver --materialize-conflict", continue: "deliver" },
    },
  }), [
    "! deliver refused — kei/conflicted",
    "   integration-failed reason=conflict targetHead=target-head",
    "   conflictPaths",
    "   │ a.txt",
    "   │ z.txt",
    "   recovery materialize conflicts · deliver --materialize-conflict",
    "   recovery continue after resolve and commit · deliver",
  ].join("\n"));
});

test("merge-state-present and materialized conflict render their public fields", () => {
  const contract = contractId("kei/conflicted");
  const targetHead = snapshotId("target-head");
  const workspace = { kind: "worktree" as const, path: "/tmp/wt" };
  assert.equal(renderText({
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: { kind: "merge-state-present", contractId: contract, workspace },
  }), [
    "! deliver refused — kei/conflicted",
    "   merge-state-present workspace=worktree path=/tmp/wt",
  ].join("\n"));
  assert.equal(renderText({
    kind: "integration-conflict-materialized",
    targetHead,
    conflictPaths: ["a.txt", "z.txt"],
    workspace,
  }), [
    "integration-conflict-materialized targetHead=target-head",
    "   conflictPaths",
    "   │ a.txt",
    "   │ z.txt",
    "   workspace worktree /tmp/wt",
  ].join("\n"));
});

test("unmerged index paths render as a complete public refusal", () => {
  const contract = contractId("kei/conflicted");
  assert.equal(renderText({
    kind: "refused",
    verb: "deliver",
    contract,
    refusal: { kind: "unmerged-paths", contractId: contract, paths: ["a.txt", "z.txt"] },
  }), [
    "! deliver refused — kei/conflicted",
    "   unmerged-paths",
    "   paths",
    "   │ a.txt",
    "   │ z.txt",
  ].join("\n"));
});
