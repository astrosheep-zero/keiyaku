import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTRACT_DELIVERER_SKILL,
  CONTRACT_REVIEWER_SKILL,
  renderContractGuidance,
} from "../src/contract-guidance.js";
import {
  contractHead,
  contractId,
  documentKey,
  entryUlid,
  snapshotId,
  type ContractState,
} from "../src/core/facts/types.js";

const source = "# Guidance\r\n\r\n## Context\r\nExact source bytes.\r\n";

function state(currentArc: ContractState["currentArc"]): ContractState {
  return {
    id: contractId("kei/guidance"),
    head: contractHead("head"),
    coordinates: { start: snapshotId("start"), workspace: "worktree" },
    terms: {
      document: { bytes: source, key: documentKey("document") },
      segments: [],
      gates: [],
      after: [],
    },
    bound: null,
    delivery: null,
    attestations: [],
    ...(currentArc === undefined ? {} : { currentArc }),
    terminal: null,
  };
}

test("guidance preserves source bytes and appends one Fulfillment H2", () => {
  const guidance = renderContractGuidance(state(undefined));

  assert.ok(
    guidance.startsWith(
      "---\ncontract: kei/guidance\ndescription: This is a read-only projection. Do not edit manually.\n---\n\n",
    ),
  );
  assert.ok(guidance.includes(source.trimEnd()));
  assert.equal(guidance.match(/^## Fulfillment$/gm)?.length, 1);
  assert.match(guidance, /^### Appointment$/m);
  assert.match(guidance, /^### Worktree$/m);
  assert.doesNotMatch(
    guidance.slice(guidance.indexOf("### Worktree"), guidance.indexOf("### Deliverer")),
    /\.agents\/skills\/keiyaku-(deliver|review)\/SKILL\.md/,
  );
  assert.match(guidance, /^### Deliverer$/m);
  assert.match(guidance, /When an Arc is active, stay within that current chapter\./);
  assert.match(guidance, /Implement and verify the Objective under the Design, Region, and Criteria in this Contract\./);
  assert.match(guidance, /Read the Deliverer operating procedures at `\.agents\/skills\/keiyaku-deliver\/SKILL\.md`/);
  assert.match(guidance, /^### Reviewer$/m);
  assert.match(guidance, /Read the Reviewer operating procedures at `\.agents\/skills\/keiyaku-review\/SKILL\.md`/);
  assert.doesNotMatch(guidance, /^## Arc$/m);
  assert.ok(guidance.endsWith("\n"));
});

test("seat skills are static operating guidance without Contract facts", () => {
  assert.match(CONTRACT_DELIVERER_SKILL, /^name: keiyaku-deliver$/m);
  assert.match(CONTRACT_DELIVERER_SKILL, /keiyaku deliver <contract> --include-dirty/);
  assert.match(CONTRACT_REVIEWER_SKILL, /^name: keiyaku-review$/m);
  assert.match(CONTRACT_REVIEWER_SKILL, /keiyaku review <contract> --satisfied/);
  assert.match(CONTRACT_DELIVERER_SKILL, /materialize-conflict/);
  assert.match(CONTRACT_REVIEWER_SKILL, /stale after it changes/);
  for (const skill of [CONTRACT_DELIVERER_SKILL, CONTRACT_REVIEWER_SKILL]) {
    assert.doesNotMatch(skill, /kei\/guidance|## Arc|Seat: Deliverer|Seat: Reviewer/);
  }
});

test("guidance inserts the current Arc before Fulfillment", () => {
  const guidance = renderContractGuidance(
    state({
      v: 1,
      kind: "arc",
      contract: contractId("kei/guidance"),
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      at: "2026-08-13T00:00:00.000Z",
      data: { seq: 2, title: "Second", objective: "Continue.", brief: "Do the next coherent work." },
    }),
  );

  assert.match(guidance, /^## Arc\n\n### Sequence\n\n2$/m);
  assert.ok(guidance.indexOf("## Arc") < guidance.indexOf("## Fulfillment"));
});
