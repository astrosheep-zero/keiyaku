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
      cleanup: { phase: "destroy", name: "destroy", detail: { kind: "timeout" } },
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
