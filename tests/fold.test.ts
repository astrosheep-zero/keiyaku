import assert from "node:assert/strict";
import test from "node:test";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  changeId,
  contractId,
  documentKey,
  entryUlid,
  gate,
  snapshotId,
  type AttestationEntry,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";

const id = contractId("kei/fold-history");
const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function uniqueEntryUlid(index: number) {
  let value = index;
  let suffix = "";
  do {
    suffix = `${ulidAlphabet[value % ulidAlphabet.length]}${suffix}`;
    value = Math.floor(value / ulidAlphabet.length);
  } while (value > 0);
  return entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5${suffix.padStart(3, "0")}`);
}

function entry<K extends JournalEntry["kind"]>(
  kind: K,
  data: Extract<JournalEntry, { kind: K }>["data"],
  index: number,
): Extract<JournalEntry, { kind: K }> {
  return {
    v: 1,
    kind,
    contract: id,
    entry: uniqueEntryUlid(index),
    at: "2026-08-07T00:00:00Z",
    data,
  } as Extract<JournalEntry, { kind: K }>;
}

test("foldJournal preserves a large interleaved attestation history and final state", () => {
  let index = 0;
  const entries: JournalEntry[] = [
    entry("bind", {
      coordinates: { start: snapshotId("initial"), workspace: "here" },
      terms: {
        document: { bytes: "# Fold history\n", key: documentKey("fold-history") },
        segments: [],
        gates: [],
        after: [],
      },
    }, index++),
    entry("bound", {}, index++),
  ];
  const attestations: AttestationEntry[] = [];
  let lastArc: Extract<JournalEntry, { kind: "arc" }> | undefined;
  let lastDelivery: Extract<JournalEntry, { kind: "deliver" }> | undefined;

  for (let sequence = 1; sequence <= 256; sequence += 1) {
    const beforeDelivery = entry("attestation", {
      gate: gate("verified"),
      subject: dependencyKeySet([]),
      verdict: sequence % 2 === 0 ? "satisfied" : "unsatisfied",
    }, index++);
    const arc = entry("arc", {
      seq: sequence,
      title: `Arc ${sequence}`,
      objective: `Objective ${sequence}`,
      brief: `Brief ${sequence}`,
    }, index++);
    const delivery = entry("deliver", {
      tenderSnapshot: snapshotId(`tender-${sequence}`),
      integration: {
        predecessor: snapshotId(`predecessor-${sequence}`),
        snapshot: snapshotId(`candidate-${sequence}`),
        changeId: changeId(`patch-${sequence}`),
      },
      method: "squash",
      policy: { requireBranchesToBeUpToDate: false },
    }, index++);
    const afterDelivery = entry("attestation", {
      gate: gate("reviewed"),
      subject: dependencyKeySet([]),
      verdict: sequence % 2 === 0 ? "unsatisfied" : "satisfied",
    }, index++);
    entries.push(beforeDelivery, arc, delivery, afterDelivery);
    attestations.push(beforeDelivery, afterDelivery);
    lastArc = arc;
    lastDelivery = delivery;
  }

  const folded = foldJournal(id, entries);
  const repeated = foldJournal(id, entries);

  assert.equal(folded.attestations.length, 512);
  assert.deepEqual(folded.attestations, attestations);
  for (let position = 0; position < attestations.length; position += 1) {
    assert.strictEqual(folded.attestations[position], attestations[position]);
  }
  assert.strictEqual(folded.currentArc, lastArc);
  assert.strictEqual(folded.delivery, lastDelivery);
  assert.notStrictEqual(folded.attestations, repeated.attestations);
});

test("foldJournal materializes its total state from the first bind", () => {
  const bind = entry("bind", {
    coordinates: { start: snapshotId("initial"), workspace: "here" },
    terms: {
      document: { bytes: "# Initial\n", key: documentKey("initial") },
      segments: [],
      gates: [],
      after: [],
    },
  }, 0);

  const state = foldJournal(id, [bind]);

  assert.deepEqual(state.coordinates, bind.data.coordinates);
  assert.deepEqual(state.terms, bind.data.terms);
});

test("foldJournal accepts an after replacement after bound and delivery", () => {
  const prerequisite = contractId("kei/replacement-prerequisite");
  const bind = entry("bind", {
    coordinates: { start: snapshotId("initial"), workspace: "here" },
    terms: {
      document: { bytes: "# Initial\n", key: documentKey("initial") },
      segments: [],
      gates: [],
      after: [],
    },
  }, 0);
  const delivery = entry("deliver", {
    tenderSnapshot: snapshotId("tender"),
    integration: {
      predecessor: snapshotId("predecessor"),
      snapshot: snapshotId("candidate"),
      changeId: changeId("patch"),
    },
    method: "squash",
    policy: { requireBranchesToBeUpToDate: false },
  }, 2);
  const amend = entry("amend", { ...bind.data.terms, after: [prerequisite] }, 3);

  const state = foldJournal(id, [bind, entry("bound", {}, 1), delivery, amend]);

  assert.deepEqual(state.terms.after, [prerequisite]);
  assert.strictEqual(state.bound?.kind, "bound");
  assert.strictEqual(state.delivery, delivery);
});
