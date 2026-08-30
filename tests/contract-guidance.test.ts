import assert from "node:assert/strict";
import test from "node:test";
import { CONTRACT_DELIVERER_SKILL, CONTRACT_REVIEWER_SKILL, renderContractGuidance } from "../src/contract-guidance.js";
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
  assert.deepEqual([...fulfillment.matchAll(/^### (.+)$/gm)].map((match) => match[1]), [
    "Appointment",
    "Worktree",
    "Deliverer",
    "Reviewer",
  ]);
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

test("seat skills distinguish the acceptance floor from round direction", () => {
  assert.match(CONTRACT_DELIVERER_SKILL, /^name: keiyaku-deliver$/m);
  assert.match(CONTRACT_DELIVERER_SKILL, /The terms are the standing acceptance floor/);
  assert.match(CONTRACT_DELIVERER_SKILL, /commission is the round's direction/);
  assert.match(CONTRACT_DELIVERER_SKILL, /You owe a candidate, not decisions about the Contract/);
  assert.match(CONTRACT_DELIVERER_SKILL, /Stay within the dispatched Arc; Contract lifecycle is not yours to decide/);
  assert.match(CONTRACT_DELIVERER_SKILL, /ungrounded term — one that presupposes a decision nobody has made/);
  assert.match(CONTRACT_DELIVERER_SKILL, /keiyaku deliver <contract> --include-dirty/);
  assert.match(CONTRACT_DELIVERER_SKILL, /keiyaku deliver <contract> --materialize-conflict/);

  assert.match(CONTRACT_REVIEWER_SKILL, /^name: keiyaku-review$/m);
  assert.match(CONTRACT_REVIEWER_SKILL, /commission .* owns the question/u);
  assert.match(CONTRACT_REVIEWER_SKILL, /You own the answer/);
  assert.match(CONTRACT_REVIEWER_SKILL, /First decide whether each journaled Criterion is adjudicable as written/);
  assert.match(CONTRACT_REVIEWER_SKILL, /candidate and its evidence without asking the author anything further/);
  assert.match(CONTRACT_REVIEWER_SKILL, /Criteria are a floor, not a ceiling/);
  assert.match(CONTRACT_REVIEWER_SKILL, /Testimony is two-valued: satisfied or unsatisfied/);
  assert.match(CONTRACT_REVIEWER_SKILL, /required evidence is missing, failed, or stale/);
  assert.match(CONTRACT_REVIEWER_SKILL, /term defect is not a third outcome: testify unsatisfied/);
  assert.match(CONTRACT_REVIEWER_SKILL, /covered, your findings, any term defects, and any missing evidence/);
  assert.match(CONTRACT_REVIEWER_SKILL, /keiyaku review <contract> --satisfied --summary <conclusion>/);
  assert.match(CONTRACT_REVIEWER_SKILL, /keiyaku review <contract> --unsatisfied --summary <finding>/);

  for (const skill of [CONTRACT_DELIVERER_SKILL, CONTRACT_REVIEWER_SKILL]) {
    assert.doesNotMatch(
      skill,
      /constructible current failure|original intent|future source edit|second unsatisfied review/u,
    );
    assert.doesNotMatch(skill, /kei\/guidance|## Arc|Seat: Deliverer|Seat: Reviewer/);
  }
  assert.doesNotMatch(CONTRACT_REVIEWER_SKILL, /term defect receives a report|without recording a verdict/u);
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
