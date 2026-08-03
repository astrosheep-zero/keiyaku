import assert from "node:assert/strict";
import test from "node:test";
import { foldJournal } from "../src/core/facts/fold.js";
import type { Offer } from "../src/core/facts/admission.js";
import {
  contractHead,
  contractId,
  entryUlid,
  type BindEntry,
  type ContractId,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { classifyUnknownAttempt } from "../src/core/protocol/attempt.js";
import type { ContractsObservation } from "../src/core/protocol/observe.js";

const AT = "2026-08-03T00:00:00Z";

function bindEntry(id: ContractId, entry = "01ARZ3NDEKTSV4RRFFQ69G5FAV"): BindEntry {
  return {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid(entry),
    at: AT,
    actor: "test",
    data: {
      title: "Attempt contract",
      context: "Context",
      objective: "Objective",
      design: "Design",
      region: ["src"],
      criteria: ["criterion"],
      verification: [],
      extensions: [],
    },
  };
}

function captured(contracts: readonly [ContractId, readonly JournalEntry[]][]): ContractsObservation {
  return {
    carrierCommit: null,
    contracts: new Map(contracts.map(([id, entries]) => [id, {
      id,
      entries,
      state: entries.length === 0 ? null : foldJournal(id, entries, contractHead("a".repeat(40))),
    }])),
  };
}

test("unknown classifier accepts exact canonical entries and reports byte collisions", () => {
  const id = contractId("classification-contract");
  const planned = bindEntry(id);
  const offer: Offer = { facts: [{ contractId: id, expectedHead: null, entries: [planned] }] };
  assert.deepEqual(classifyUnknownAttempt(captured([[id, [planned]]]), offer), { kind: "accepted" });
  const changed: BindEntry = { ...planned, actor: "different" };
  const collision = classifyUnknownAttempt(captured([[id, [changed]]]), offer);
  assert.equal(collision.kind, "collision");
  if (collision.kind === "collision") {
    assert.equal(collision.planned.entry, changed.entry);
    assert.notEqual(collision.plannedBytes, collision.observedBytes);
  }
});

test("unknown classifier distinguishes unchanged and moved heads across contracts", () => {
  const first = contractId("retry-contract");
  const second = contractId("moved-contract");
  const firstEntry = bindEntry(first);
  const secondEntry = bindEntry(second, "01ARZ3NDEKTSV4RRFFQ69G5FAY");
  const offer: Offer = { facts: [
    { contractId: first, expectedHead: null, entries: [firstEntry] },
    { contractId: second, expectedHead: null, entries: [secondEntry] },
  ] };
  assert.deepEqual(classifyUnknownAttempt(captured([[first, []], [second, []]]), offer), { kind: "retry-offer" });
  assert.deepEqual(
    classifyUnknownAttempt(captured([[first, []], [second, [bindEntry(second, "01ARZ3NDEKTSV4RRFFQ69G5FAZ")]]]), offer),
    { kind: "redecide" },
  );
});

test("unknown classifier rejects incomplete, implicit, duplicate, and partial offers", () => {
  const first = contractId("validation-first");
  const second = contractId("validation-second");
  const entry = bindEntry(first);
  const observation = captured([[first, []], [second, []]]);
  assert.throws(() => classifyUnknownAttempt(observation, { facts: [] }), /nonempty/);
  assert.throws(() => classifyUnknownAttempt(observation, { facts: [{ contractId: first, expectedHead: null, entries: [] }] }), /planned entries/);
  assert.throws(() => classifyUnknownAttempt(observation, { facts: [{ contractId: first, entries: [entry] }] }), /explicit expected head/);
  assert.throws(() => classifyUnknownAttempt(observation, { facts: [
    { contractId: first, expectedHead: null, entries: [entry] },
    { contractId: first, expectedHead: null, entries: [entry] },
  ] }), /duplicate contract/);
  assert.throws(() => classifyUnknownAttempt(observation, { facts: [
    { contractId: first, expectedHead: null, entries: [entry] },
    { contractId: second, expectedHead: null, entries: [{ ...entry, contract: second }] },
  ] }), /duplicate planned entry ULID/);
  assert.throws(() => classifyUnknownAttempt(captured([[first, [entry]], [second, []]]), {
    facts: [
      { contractId: first, expectedHead: null, entries: [entry] },
      { contractId: second, expectedHead: null, entries: [bindEntry(second, "01ARZ3NDEKTSV4RRFFQ69G5FAY")] },
    ],
  }), /partial unknown attempt match/);
  assert.throws(() => classifyUnknownAttempt(observation, {
    facts: [{ contractId: first, expectedHead: null, entries: [{ ...entry, actor: "" }] }],
  }), /actor/);
});
