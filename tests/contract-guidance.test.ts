import assert from "node:assert/strict";
import test from "node:test";
import { renderContractGuidance } from "../src/contract-worktree.js";
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
  assert.match(guidance, /^### Deliverer$/m);
  assert.match(guidance, /When an Arc is active, stay within that current chapter\./);
  assert.match(
    guidance,
    /Deliver from this worktree\. A clean worktree delivers HEAD; uncommitted work\nneeds `deliver --include-dirty`, which captures the final non-ignored tree and\nstages or commits nothing\. If deliver reports a conflict, run\n`deliver --materialize-conflict`, resolve the conflicted files, and continue\nwith `deliver --include-dirty` while the merge stays uncommitted\./,
  );
  assert.match(guidance, /^### Reviewer$/m);
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
