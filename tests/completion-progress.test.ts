import assert from "node:assert/strict";
import test from "node:test";
import {
  contractId,
  contractHead,
  entryUlid,
  snapshotId,
  type ContractState,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { InvocationAccumulator } from "../src/library/invocation.js";
import { project } from "../src/library/outcome.js";
import type { AcceptedAdmission } from "../src/protocol/attempt.js";
import { contractCheckpoint, type ContractCheckpoint } from "../src/protocol/progress.js";

function checkpoint(id = "kei/progress", head = "initial"): ContractCheckpoint {
  const state: ContractState = {
    id: contractId(id),
    head: contractHead(head),
    coordinates: { start: snapshotId("start"), workspace: "worktree" },
    terms: {
      document: { bytes: "contract", key: "document" as ContractState["terms"]["document"]["key"] },
      segments: [],
      gates: [],
      requirements: {},
      after: [],
    },
    delivery: null,
    currentIntegration: null,
    attestations: [],
    terminal: null,
  };
  return { state, journal: [] };
}

function admission(before: ContractCheckpoint, sequence: number): AcceptedAdmission {
  const name = String(sequence).padStart(2, "0");
  const fact: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: before.state.id,
    entry: entryUlid(`${"0".repeat(24)}${name}`),
    at: "2026-09-05T00:00:00.000Z",
    data: { seq: sequence, title: name, body: "fixture" },
  };
  return {
    kind: "accepted",
    state: { ...before.state, head: contractHead(name) },
    journal: [...before.journal, fact],
    facts: [fact],
  };
}

function record(progress: InvocationAccumulator, step: AcceptedAdmission) {
  progress.recordPublication(step.state.id, step.state.head!, step.facts);
  progress.recordCheckpoint(step);
}

test("an observed checkpoint cannot manufacture an invocation receipt", () => {
  const progress = new InvocationAccumulator();
  const captured = contractCheckpoint(admission(checkpoint(), 1));
  progress.recordCheckpoint(captured);
  assert.deepEqual(progress.snapshot().facts, []);
  assert.equal(progress.checkpoint(captured.state.id), undefined);
  const original = new DOMException("stopped", "AbortError");
  const projected = project("arc", progress.snapshot(), {
    kind: "failed",
    contract: captured.state.id,
    error: original,
  });
  assert.ok(projected.kind === "failed");
  assert.equal(projected.error, original);
});

test("conflicting identities reject an entire receipt before mutating progress", () => {
  const leading = admission(checkpoint(), 1),
    next = admission(leading, 2);
  const conflict: JournalEntry = { ...leading.facts[0]!, at: "2026-08-06T00:00:01.000Z" };
  const progress = new InvocationAccumulator();
  record(progress, leading);
  assert.throws(
    () => progress.recordPublication(leading.state.id, next.state.head!, [...next.facts, conflict]),
    AuthorityCorruptionError,
  );
  assert.deepEqual(progress.snapshot().facts, leading.facts);
  assert.equal(progress.head(leading.state.id), leading.state.head);
  const empty = new InvocationAccumulator();
  assert.throws(
    () => empty.recordPublication(leading.state.id, leading.state.head!, [leading.facts[0]!, conflict]),
    AuthorityCorruptionError,
  );
  assert.deepEqual(empty.snapshot().facts, []);
});
