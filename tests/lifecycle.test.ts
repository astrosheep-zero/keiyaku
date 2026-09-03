import assert from "node:assert/strict";
import test from "node:test";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { decodeGateReport } from "../src/core/facts/gate.js";
import { dependencyKeySet } from "../src/core/subject.js";
import {
  changeId,
  contractId,
  documentKey,
  entryUlid,
  gate,
  snapshotId,
  type ContractId,
  type ContractState,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { decodeAbandonRefusal } from "../src/core/verbs/abandon.js";
import { decodeAmendRefusal } from "../src/core/verbs/amend.js";
import { decideAttestation, decodeAttestationRefusal } from "../src/core/verbs/attestation.js";
import { decodeBindRefusal } from "../src/core/verbs/bind.js";
import { decideDeliver, decodeDeliverRefusal } from "../src/core/verbs/deliver.js";
import { decidePlacement, decodePlacementRefusal } from "../src/core/verbs/placement.js";

const id = contractId("kei/lifecycle-cycle");
const prerequisite = contractId("kei/lifecycle-prerequisite");
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

function terms(after: readonly ContractId[] = [], gates: readonly ReturnType<typeof gate>[] = []) {
  return {
    document: { bytes: "# Lifecycle cycle\n", key: documentKey("lifecycle-cycle") },
    segments: [],
    gates,
    after,
  };
}

function entry<K extends JournalEntry["kind"]>(
  kind: K,
  data: Extract<JournalEntry, { kind: K }>["data"],
  index: number,
  contract: ContractId = id,
): Extract<JournalEntry, { kind: K }> {
  return {
    v: 1,
    kind,
    contract,
    entry: uniqueEntryUlid(index),
    at: "2026-08-07T00:00:00Z",
    data,
  } as Extract<JournalEntry, { kind: K }>;
}

function bindEntry(index: number, contract: ContractId = id, after: readonly ContractId[] = []) {
  return entry(
    "bind",
    {
      coordinates: { start: snapshotId("start"), workspace: "worktree" },
      terms: terms(after, [gate("reviewed")]),
    },
    index,
    contract,
  );
}

function deliveryData(snapshot: string) {
  return {
    tenderSnapshot: snapshotId(`tender-${snapshot}`),
    integration: {
      predecessor: snapshotId("predecessor"),
      snapshot: snapshotId(snapshot),
      changeId: changeId(`change-${snapshot}`),
    },
    method: "squash" as const,
    policy: { requireBranchesToBeUpToDate: false },
  };
}

function fold(entries: readonly JournalEntry[], contract: ContractId = id): ContractState {
  return foldJournal(contract, entries);
}

function observation(states: ReadonlyArray<readonly [ContractId, ContractState | null]>) {
  return new Map(states);
}

function offeredEntries(decision: { kind: string; offer?: { facts: ReadonlyArray<{ entries: readonly JournalEntry[] }> } }) {
  assert.equal(decision.kind, "offer");
  if (decision.kind !== "offer" || decision.offer === undefined) throw new Error("expected an offer");
  return decision.offer.facts.flatMap((fact) => fact.entries);
}

test("delivery replacement carries a satisfied gate to placement", () => {
  const bind = bindEntry(0);
  const waiting = fold([bind]);
  assert.equal(waiting.bound, null);
  assert.equal(waiting.delivery, null);
  assert.equal(waiting.terminal, null);

  const firstDelivery = decideDeliver({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:01Z",
      preparation: { kind: "prepared", document: waiting.terms.document.key, data: deliveryData("candidate-1") },
    },
    attempt: { entryUlids: [uniqueEntryUlid(1), uniqueEntryUlid(2)] },
    observation: observation([[id, waiting]]),
  });
  const firstFacts = offeredEntries(firstDelivery);
  assert.deepEqual(
    firstFacts.map((fact) => fact.kind),
    ["bound", "deliver"],
  );

  const delivered = fold([bind, ...firstFacts]);
  assert.equal(delivered.bound?.kind, "bound");
  assert.equal(delivered.delivery?.data.integration.snapshot, snapshotId("candidate-1"));

  const laterDelivery = decideDeliver({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:02Z",
      preparation: { kind: "prepared", document: delivered.terms.document.key, data: deliveryData("candidate-2") },
    },
    attempt: { entryUlids: [uniqueEntryUlid(3)] },
    observation: observation([[id, delivered]]),
  });
  const laterFacts = offeredEntries(laterDelivery);
  assert.deepEqual(
    laterFacts.map((fact) => fact.kind),
    ["deliver"],
  );

  const replaced = fold([bind, ...firstFacts, ...laterFacts]);
  assert.equal(replaced.bound?.entry, firstFacts[0]?.entry);
  assert.equal(replaced.delivery?.data.integration.snapshot, snapshotId("candidate-2"));

  const satisfied = decideAttestation({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:03Z",
      preparation: {
        kind: "prepared",
        data: {
          gate: gate("reviewed"),
          subject: dependencyKeySet([{ kind: "change", value: changeId("change-candidate-2") }]),
          verdict: "satisfied",
        },
      },
    },
    attempt: { entryUlids: [uniqueEntryUlid(4)] },
    observation: observation([[id, replaced]]),
  });
  const satisfiedFacts = offeredEntries(satisfied);
  const attested = fold([bind, ...firstFacts, ...laterFacts, ...satisfiedFacts]);
  const placeable = decidePlacement({
    input: { contractId: id, at: "2026-08-07T00:00:04Z" },
    attempt: { entryUlids: [uniqueEntryUlid(5)] },
    observation: observation([[id, attested]]),
  });
  assert.equal(placeable.kind, "offer");

  const unsatisfied = decideAttestation({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:05Z",
      preparation: {
        kind: "prepared",
        data: {
          gate: gate("reviewed"),
          subject: dependencyKeySet([{ kind: "change", value: changeId("change-candidate-2") }]),
          verdict: "unsatisfied",
        },
      },
    },
    attempt: { entryUlids: [uniqueEntryUlid(6)] },
    observation: observation([[id, attested]]),
  });
  const superseded = fold([bind, ...firstFacts, ...laterFacts, ...satisfiedFacts, ...offeredEntries(unsatisfied)]);
  const blockedByGate = decidePlacement({
    input: { contractId: id, at: "2026-08-07T00:00:06Z" },
    attempt: { entryUlids: [uniqueEntryUlid(7)] },
    observation: observation([[id, superseded]]),
  });
  assert.deepEqual(blockedByGate, {
    kind: "refused",
    refusal: {
      kind: "gates-unsatisfied",
      contractId: id,
      unmet: [{ gate: "reviewed", current: { kind: "attested", verdict: "unsatisfied", at: "2026-08-07T00:00:05Z" } }],
    },
  });

});

test("malformed inherited refusals, journals, and folds refuse without inventing status", () => {
  const bind = bindEntry(0);
  const bound = entry("bound", {}, 1);
  const deliver = entry("deliver", deliveryData("candidate"), 2);
  const claimed = entry("claimed", { delivery: deliver.entry }, 3);
  const abandoned = entry("abandoned", {}, 4);

  assert.throws(() => foldJournal(id, [bind, claimed]), /claimed requires a deliver/);
  assert.throws(() => foldJournal(id, [bind, bound, { ...bound, entry: uniqueEntryUlid(20) }]), /bound may appear only once/);
  assert.throws(() => foldJournal(id, [bind, abandoned, bound]), /terminal contract cannot accept bound/);
  assert.throws(() => decodeJournal("not a journal\n"), /journal entry is not valid JSON/);
  assert.throws(
    () => decodeJournal(encodeEntry(deliver).replace('"snapshot":"candidate"', '"snapshot":""')),
    /data\.deliver\.integration\.snapshot/,
  );

  const malformed = { kind: "terminal", contractId: String(id), extra: true };
  for (const decode of [
    decodeBindRefusal,
    decodeAmendRefusal,
    decodeDeliverRefusal,
    decodeAbandonRefusal,
    decodeAttestationRefusal,
  ]) {
    assert.throws(() => decode(malformed), /malformed .*refusal/);
  }
  assert.throws(
    () =>
      decodePlacementRefusal({
        kind: "prerequisites-unsatisfied",
        contractId: String(id),
        unmet: [{ contractId: String(prerequisite), state: "unknown" }],
      }),
    /malformed placement refusal/,
  );
  assert.throws(
    () => decodeGateReport({ gate: "reviewed", current: { kind: "attested", verdict: "passed", at: "2026-08-07T00:00:00Z" } }),
    /malformed gate report/,
  );
  assert.deepEqual(decodePlacementRefusal({ kind: "delivery-missing", contractId: String(id) }), {
    kind: "delivery-missing",
    contractId: id,
  });
});
