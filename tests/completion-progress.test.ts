import assert from "node:assert/strict";
import test from "node:test";
import type { ContractHead, ContractId, ContractState, EntryUlid, JournalEntry } from "../src/core/facts/types.js";
import type { AcceptedProtocolStep } from "../src/protocol/outcome.js";
import {
  beginCompletion,
  completeLeadingAdmission,
  contractCheckpoint,
  recordCompletionStep,
  type ContractCheckpoint,
} from "../src/protocol/progress.js";

function checkpoint(id = "kei/progress", head = "initial"): ContractCheckpoint {
  const state: ContractState = {
    id: id as ContractId,
    head: head as ContractHead,
    coordinates: { start: "start" as ContractState["coordinates"]["start"], workspace: "worktree" },
    terms: {
      document: { bytes: "contract", key: "document" as ContractState["terms"]["document"]["key"] },
      segments: [],
      gates: [],
      after: [],
    },
    bound: null,
    delivery: null,
    currentIntegration: null,
    attestations: [],
    terminal: null,
  };
  return { state, journal: [] };
}

function admission(before: ContractCheckpoint, name: string): AcceptedProtocolStep {
  const fact: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: before.state.id,
    entry: name as EntryUlid,
    at: "2026-09-05T00:00:00.000Z",
    data: { seq: before.journal.length, title: name, objective: "fixture", brief: "fixture" },
  };
  return {
    kind: "accepted",
    state: { ...before.state, head: name as ContractHead },
    journal: [...before.journal, fact],
    facts: [fact],
  };
}

test("a completion begins from an observation without manufacturing an accepted result", () => {
  const captured = checkpoint();
  const progress = beginCompletion(captured);
  assert.deepEqual(progress.checkpoint, captured);
  assert.deepEqual(progress.facts, []);
  assert.equal("kind" in progress, false);
  assert.equal("kind" in progress.checkpoint, false);
});

test("extracting a checkpoint cannot copy a leading admission's facts or residue", () => {
  const leading = admission(checkpoint(), "review");
  const withResidue: AcceptedProtocolStep = {
    ...leading,
    seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "close" }],
  };
  const captured = contractCheckpoint(withResidue);
  assert.deepEqual(Object.keys(captured).sort(), ["journal", "state"]);
  assert.deepEqual(beginCompletion(captured).facts, []);
});

test("a stopped completion preserves its real leading admission exactly once", () => {
  const leading = admission(checkpoint(), "review");
  const progress = beginCompletion(leading);
  const result = completeLeadingAdmission(leading, progress);
  assert.deepEqual(result, leading);
  assert.deepEqual(progress.facts, []);
});

test("completion facts exclude historical and leading facts and retain execution order", () => {
  const historical = admission(checkpoint(), "history");
  const leading = admission(historical, "delivery");
  const verification = admission(leading, "verification");
  const placement = admission(verification, "placement");
  const empty = beginCompletion(leading);
  const verified = recordCompletionStep(empty, verification);
  const completed = recordCompletionStep(verified, placement);
  const result = completeLeadingAdmission(leading, completed);
  assert.deepEqual(empty.facts, []);
  assert.deepEqual(verified.facts.map((fact) => fact.entry), ["verification"]);
  assert.deepEqual(completed.facts.map((fact) => fact.entry), ["verification", "placement"]);
  assert.deepEqual(result.facts.map((fact) => fact.entry), ["delivery", "verification", "placement"]);
  assert.equal(result.state.head, "placement");
  assert.deepEqual(result.journal.map((fact) => fact.entry), ["history", "delivery", "verification", "placement"]);
});

test("an observation-only continuation reports only the fact it actually admits", () => {
  const prior = admission(checkpoint(), "earlier-delivery");
  const step = admission(prior, "claim");
  const progress = recordCompletionStep(beginCompletion(contractCheckpoint(prior)), step);
  assert.deepEqual(progress.facts.map((fact) => fact.entry), ["claim"]);
  assert.equal(progress.checkpoint.state.head, "claim");
});

test("physical and seat-close reports survive every completion step without input mutation", () => {
  const leading: AcceptedProtocolStep = {
    ...admission(checkpoint(), "leading"),
    physical: { effects: [], lag: [{ kind: "worktree-retained", path: "/leading" }] },
    seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "leading close" }],
  };
  const step: AcceptedProtocolStep = {
    ...admission(leading, "step"),
    physical: { effects: [], lag: [{ kind: "worktree-retained", path: "/step" }] },
    seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "step close" }],
  };
  const progress = recordCompletionStep(beginCompletion(leading), step);
  const result = completeLeadingAdmission(leading, progress);
  assert.deepEqual(result.physical?.lag.map((lag) => "path" in lag ? lag.path : null), ["/leading", "/step"]);
  assert.deepEqual(result.seatClose?.map((lag) => lag.diagnostic), ["leading close", "step close"]);
  assert.equal(leading.physical?.lag.length, 1);
  assert.equal(progress.physical?.lag.length, 1);
});

test("a completion cannot silently replace its checkpoint with another contract", () => {
  const progress = beginCompletion(checkpoint());
  const other = admission(checkpoint("kei/other"), "other-step");
  assert.throws(() => recordCompletionStep(progress, other), /another contract/);
  assert.throws(() => completeLeadingAdmission(other, progress), /another contract/);
  assert.equal(progress.checkpoint.state.id, "kei/progress");
  assert.deepEqual(progress.facts, []);
});
