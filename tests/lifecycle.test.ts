import assert from "node:assert/strict";
import test from "node:test";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { decodeGateReport } from "../src/core/facts/gate.js";
import {
  changeId,
  contractId,
  documentKey,
  entryUlid,
  gate,
  snapshotId,
  type ContractId, type JournalEntry
} from "../src/core/facts/types.js";
import { decodeAbandonRefusal } from "../src/core/verbs/abandon.js";
import { applyAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import type { ContractBody } from "../src/body/types.js";
import { decodeAmendRefusal } from "../src/core/verbs/amend.js";
import { decodeAttestationRefusal } from "../src/core/verbs/attestation.js";
import { decodeBindRefusal } from "../src/core/verbs/bind.js";
import { decodeDeliverRefusal } from "../src/core/verbs/deliver.js";
import { decodePlacementRefusal } from "../src/core/verbs/placement.js";

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

const amendmentBody: ContractBody = {
  title: "Heading cycle",
  context: "before\n",
  objective: "objective\n",
  design: "design\n",
  region: ["src/**"],
  criteria: [{ title: "Keep", body: "kept\n" }],
  verification: [{ executor: "bash", script: "true" }],
  extensions: [],
};

function currentAmendmentDocument() {
  return decodeContractDocument(renderContractBody(amendmentBody));
}

test("an amendment still refuses every byte outside its H2 operations", () => {
  const replacement = "## Replace: Objective\nchanged\n";
  const refusals: ReadonlyArray<readonly [string, string]> = [
    [`${replacement}\n# Late heading\n`, "amend operations may contain H2 sections only"],
    [`# One\n\n# Two\n\n${replacement}`, "amend operations may contain H2 sections only"],
    [`stray prose\n${replacement}`, "amend operations contain bytes outside H2 sections"],
    [`# Title\nstray prose\n${replacement}`, "amend operations contain bytes outside H2 sections"],
  ];

  for (const [source, diagnostic] of refusals) {
    assert.throws(
      () => applyAmendDocument(source, currentAmendmentDocument()),
      (error: unknown) => error instanceof TypeError && error.message === diagnostic,
      source,
    );
  }
});

test("a bind document still requires exactly one H1 title", () => {
  assert.throws(
    () => decodeContractDocument("## Context\nfacts\n"),
    (error: unknown) =>
      error instanceof TypeError && error.message === "contract document requires exactly one H1 title",
  );
});
