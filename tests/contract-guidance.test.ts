import assert from "node:assert/strict";
import test from "node:test";
import { renderContractGuidance } from "../src/contract-guidance.js";
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

test("guidance preserves source bytes and projects the lawful fulfillment structure", () => {
  const guidance = renderContractGuidance(state(undefined));
  const fulfillment = guidance.slice(guidance.indexOf("## Fulfillment"));

  assert.ok(
    guidance.startsWith(
      "---\ncontract: kei/guidance\ndescription: This is a read-only projection. Do not edit manually.\n---\n\n",
    ),
  );
  assert.ok(guidance.includes(source.trimEnd()));
  assert.equal(fulfillment.match(/^## Fulfillment$/gm)?.length, 1);
  assert.deepEqual(
    [...fulfillment.matchAll(/^### (.+)$/gm)].map((match) => match[1]),
    ["Appointment", "Worktree", "Deliverer", "Reviewer"],
  );
  assert.match(fulfillment, /every commission into it names exactly one seat — Deliverer or Reviewer/);
  assert.match(fulfillment, /terms are the standing acceptance floor, changed only by journaled amend/);
  assert.match(fulfillment, /full current worktree state is the candidate/);
  assert.match(fulfillment, /first decides whether each Criterion is adjudicable as written/);
  assert.match(fulfillment, /covered Criteria, findings, term defects, and missing evidence/);
  assert.match(
    fulfillment,
    /Read the Deliverer operating procedures at `\.agents\/skills\/keiyaku-deliver\/SKILL\.md`\./,
  );
  assert.match(
    fulfillment,
    /Read the Reviewer operating procedures at `\.agents\/skills\/keiyaku-review\/SKILL\.md`\./,
  );
  assert.doesNotMatch(guidance, /^## Arc$/m);
  assert.ok(guidance.endsWith("\n"));
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
