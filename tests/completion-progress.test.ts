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
import type { AcceptedProtocolStep } from "../src/protocol/outcome.js";
import {
  ExecutionProgress,
  contractCheckpoint,
  executionStop,
  type ContractCheckpoint,
} from "../src/protocol/progress.js";
import { executionReceipt, receiptFromProgress, withExecutionReceipt } from "../src/library/execution-result.js";

function checkpoint(id = "kei/progress", head = "initial"): ContractCheckpoint {
  const state: ContractState = {
    id: contractId(id),
    head: contractHead(head),
    coordinates: { start: snapshotId("start"), workspace: "worktree" },
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

function admission(before: ContractCheckpoint, sequence: number): AcceptedProtocolStep {
  const name = String(sequence).padStart(2, "0");
  const fact: JournalEntry = {
    v: 1,
    kind: "arc",
    contract: before.state.id,
    entry: entryUlid(`${"0".repeat(24)}${name}`),
    at: "2026-09-05T00:00:00.000Z",
    data: { seq: sequence, title: name, objective: "fixture", brief: "fixture" },
  };
  return {
    kind: "accepted",
    state: { ...before.state, head: contractHead(name) },
    journal: [...before.journal, fact],
    facts: [fact],
  };
}

test("an observed checkpoint cannot manufacture an invocation receipt", () => {
  const progress = new ExecutionProgress();
  const captured = contractCheckpoint(admission(checkpoint(), 1));
  assert.deepEqual(Object.keys(captured).sort(), ["journal", "state"]);
  assert.deepEqual(progress.snapshot().facts, []);
  assert.equal(progress.head(captured.state.id), undefined);
  assert.throws(() => progress.accepted(captured.state.id, undefined), /missing leading admission receipt/u);
});

test("extracting a checkpoint cannot copy a leading admission's facts or residue", () => {
  const leading = {
    ...admission(checkpoint(), 1),
    seatClose: [{ kind: "private-state-seat-close-failed" as const, diagnostic: "close" }],
  };
  const captured = contractCheckpoint(leading);
  assert.deepEqual(Object.keys(captured).sort(), ["journal", "state"]);
  assert.equal("facts" in captured, false);
  assert.equal("seatClose" in captured, false);
});

test("a stopped completion preserves its real leading admission exactly once", () => {
  const leading = admission(checkpoint(), 1);
  const progress = new ExecutionProgress();
  progress.recordAdmission(leading);
  progress.recordStop({
    kind: "execution-stopped",
    contractId: leading.state.id,
    stage: "placement",
    reason: "failed",
    diagnostic: "blocked",
  });
  progress.recordAdmission(leading);
  assert.deepEqual(progress.accepted(leading.state.id, {}).facts, leading.facts);
  assert.equal(progress.snapshot().stops.length, 1);
});

test("invocation facts exclude history and retain only new steps in execution order", () => {
  const history = admission(checkpoint(), 1);
  const leading = admission(history, 2);
  const verified = admission(leading, 3);
  const placed = admission(verified, 4);
  const progress = new ExecutionProgress();
  progress.recordAdmission(leading);
  const earlier = progress.snapshot();
  progress.recordAdmission(verified);
  progress.recordAdmission(placed);
  assert.deepEqual(progress.accepted(leading.state.id, {}).facts, [
    ...leading.facts,
    ...verified.facts,
    ...placed.facts,
  ]);
  assert.deepEqual(earlier.facts, leading.facts);
  assert.deepEqual(progress.checkpoint(leading.state.id)?.journal, placed.journal);
});

test("observation-only continuation reports only its actual new admission", () => {
  const earlier = admission(checkpoint(), 1);
  const claim = admission(earlier, 2);
  const progress = new ExecutionProgress();
  progress.recordAdmission(claim);
  assert.deepEqual(progress.snapshot().facts, claim.facts);
  assert.equal(progress.head(earlier.state.id), claim.state.head);
});

test("physical and seat-close reports accumulate without replay duplication or input mutation", () => {
  const leading: AcceptedProtocolStep = {
    ...admission(checkpoint(), 1),
    physical: { effects: [], lag: [{ kind: "worktree-retained", path: "/leading" }] },
    seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "first" }],
  };
  const next: AcceptedProtocolStep = {
    ...admission(leading, 2),
    physical: { effects: [], lag: [{ kind: "worktree-retained", path: "/next" }] },
    seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "second" }],
  };
  const progress = new ExecutionProgress();
  progress.recordAdmission(leading);
  progress.recordAdmission(next);
  progress.recordAdmission(next);
  assert.deepEqual(progress.snapshot().physical.lag, [...leading.physical!.lag, ...next.physical!.lag]);
  assert.deepEqual(
    progress
      .snapshot()
      .cleanup.map((issue) => (issue.kind === "private-state-seat-close" ? issue.failure.diagnostic : null)),
    ["first", "second"],
  );
  assert.equal(leading.physical!.lag.length, 1);
});

test("a dependent cannot replace the primary checkpoint or returned head", () => {
  const leading = admission(checkpoint(), 1);
  const child = admission(checkpoint("kei/child"), 2);
  const progress = new ExecutionProgress();
  progress.recordAdmission(leading);
  progress.recordAdmission(child);
  assert.equal(progress.accepted(leading.state.id, {}).head, leading.state.head);
  assert.equal(progress.checkpoint(leading.state.id)?.state.id, leading.state.id);
  assert.equal(progress.checkpoint(child.state.id)?.state.id, child.state.id);
  assert.deepEqual(progress.snapshot().facts, [...leading.facts, ...child.facts]);
});

test("receipt replay cannot rewind a newer admitted checkpoint", () => {
  const leading = admission(checkpoint(), 1),
    next = admission(leading, 2);
  const progress = new ExecutionProgress();
  progress.recordAdmission(leading);
  progress.recordAdmission(next);
  progress.recordAdmission(leading);
  assert.equal(progress.head(leading.state.id), next.state.head);
  assert.deepEqual(progress.checkpoint(leading.state.id), contractCheckpoint(next));
});

test("conflicting identities reject an entire receipt before mutating progress", () => {
  const leading = admission(checkpoint(), 1),
    next = admission(leading, 2);
  const conflict: JournalEntry = { ...leading.facts[0]!, actor: "different" as NonNullable<JournalEntry["actor"]> };
  const progress = new ExecutionProgress();
  progress.recordAdmission(leading);
  assert.throws(
    () => progress.recordPublication(leading.state.id, next.state.head!, [...next.facts, conflict]),
    AuthorityCorruptionError,
  );
  assert.deepEqual(progress.snapshot().facts, leading.facts);
  assert.equal(progress.head(leading.state.id), leading.state.head);
  const empty = new ExecutionProgress();
  assert.throws(
    () => empty.recordPublication(leading.state.id, leading.state.head!, [leading.facts[0]!, conflict]),
    AuthorityCorruptionError,
  );
  assert.deepEqual(empty.snapshot().facts, []);
});

test("all verification cleanup and leaks survive repeated candidates and dependent execution", () => {
  const progress = new ExecutionProgress(),
    primary = contractId("kei/primary"),
    child = contractId("kei/child");
  for (const [id, snapshot] of [
    [primary, "one"],
    [primary, "two"],
    [child, "three"],
  ] as const) {
    progress.recordVerification(id, snapshotId(snapshot), {
      cleanup: { phase: "destroy", command: 0, detail: { kind: "timeout" } },
      leak: { path: `/scratch/${snapshot}`, diagnostic: "retained" },
    });
  }
  assert.equal(progress.snapshot().cleanup.length, 6);
  assert.deepEqual(
    progress
      .snapshot()
      .cleanup.filter((item) => item.kind === "worktree-leak")
      .map((item) => [item.contractId, item.snapshot, item.leak.path]),
    [
      [primary, "one", "/scratch/one"],
      [primary, "two", "/scratch/two"],
      [child, "three", "/scratch/three"],
    ],
  );
});

test("a raw confirmed publication remains visible even if folding never returns", () => {
  const leading = admission(checkpoint(), 1),
    progress = new ExecutionProgress();
  progress.recordPublication(leading.state.id, leading.state.head!, leading.facts);
  assert.equal(progress.checkpoint(leading.state.id), undefined);
  const original = new AuthorityCorruptionError("fold failure");
  const error = withExecutionReceipt(original, receiptFromProgress("review", leading.state.id, progress)!);
  assert.equal(error, original);
  assert.ok(error instanceof AuthorityCorruptionError);
  assert.deepEqual(executionReceipt(error)?.facts, leading.facts);
  assert.equal(executionReceipt(error)?.head, leading.state.head);
});

test("cancellation cannot launder programming errors into operational stops", () => {
  const controller = new AbortController();
  controller.abort();
  const id = contractId("kei/stop");
  assert.equal(executionStop(id, "verification", controller.signal.reason, controller.signal).reason, "cancelled");
  for (const error of [
    new TypeError("bug"),
    new AuthorityCorruptionError("bad journal"),
    new Error("unexpected bug"),
  ]) {
    assert.throws(
      () => executionStop(id, "verification", error, controller.signal),
      (actual) => actual === error,
    );
  }
});
