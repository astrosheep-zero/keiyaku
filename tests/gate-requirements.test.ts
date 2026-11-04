import assert from "node:assert/strict";
import test from "node:test";
import { decodeJournal, encodeEntry, validateEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { gateReports, latestCurrentAttestations } from "../src/core/facts/gate.js";
import {
  changeId,
  contractId,
  documentKey,
  gate,
  requirementId,
  snapshotId,
  type AttestationData,
  type ContractState,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { uniqueEntryUlid } from "./support/journal.js";

const id = contractId("kei/requirements");
const selectedGate = gate("checks");
const first = requirementId("first");
const second = requirementId("second");
const subject = dependencyKeySet([{ kind: "snapshot", value: snapshotId("candidate") }]);

function entry<Kind extends JournalEntry["kind"]>(
  kind: Kind,
  data: Extract<JournalEntry, { kind: Kind }>["data"],
  index: number,
): Extract<JournalEntry, { kind: Kind }> {
  return {
    v: 1,
    kind,
    contract: id,
    entry: uniqueEntryUlid(index),
    at: `2026-08-07T00:00:${String(index).padStart(2, "0")}Z`,
    data,
  } as Extract<JournalEntry, { kind: Kind }>;
}

function bind() {
  return entry(
    "bind",
    {
      coordinates: { start: snapshotId("start"), workspace: "worktree" },
      terms: {
        document: { bytes: "# Requirements\n", key: documentKey("document") },
        segments: [],
        gates: [selectedGate],
        requirements: { [selectedGate]: [first, second] },
        after: [],
      },
    },
    0,
  );
}

function delivered(...testimony: readonly AttestationData[]): ContractState {
  return foldJournal(id, [
    bind(),
    entry(
      "deliver",
      {
        tenderSnapshot: snapshotId("tender"),
        integration: {
          predecessor: snapshotId("base"),
          snapshot: snapshotId("candidate"),
          changeId: changeId("patch"),
        },
        method: "squash",
        policy: { requireBranchesToBeUpToDate: false },
      },
      1,
    ),
    ...testimony.map((data, index) => entry("attestation", data, index + 2)),
  ]);
}

function attestation(requirement: typeof first, verdict: AttestationData["verdict"] = "satisfied"): AttestationData {
  return { gate: selectedGate, requirement, subject, verdict };
}

test("generic requirements accumulate independently and latest current failure supersedes only its own requirement", () => {
  const partial = delivered(attestation(first));
  const partialReport = gateReports(partial);
  assert.equal(partialReport.satisfied, false);
  assert.deepEqual(
    partialReport.reports[0]!.requirements.map((report) => report.current.kind),
    ["attested", "missing"],
  );
  assert.equal(partialReport.reports[0]!.current.kind, "missing");

  const complete = delivered(attestation(first), attestation(second));
  assert.equal(gateReports(complete).satisfied, true);
  const failed = delivered(attestation(first), attestation(second), attestation(first, "unsatisfied"));
  const current = latestCurrentAttestations(failed, new Set([selectedGate])).get(selectedGate)!;
  assert.equal(current.get(first)!.data.verdict, "unsatisfied");
  assert.equal(current.get(second)!.data.verdict, "satisfied");
  assert.equal(gateReports(failed).satisfied, false);
  const placement = (state: ContractState) =>
    decidePlacement({
      input: { contractId: id, at: "2026-08-07T00:01:00Z" },
      attempt: { entryUlids: [uniqueEntryUlid(10)] },
      observation: new Map([[id, state]]),
    });
  assert.equal(placement(complete).kind, "offer");
  assert.equal(placement(failed).kind, "refused");
});

test("stale and missing requirements stay distinct and historical subjects cannot erase current testimony", () => {
  const old = {
    ...attestation(first, "unsatisfied"),
    subject: dependencyKeySet([{ kind: "snapshot", value: snapshotId("older") }]),
  };
  const current = delivered(attestation(first), old);
  assert.equal(gateReports(current).reports[0]!.requirements[0]!.current.kind, "attested");
  const stale = gateReports(delivered(old)).reports[0]!.requirements;
  assert.deepEqual(
    stale.map((report) => report.current.kind),
    ["stale", "missing"],
  );
});

test("changing current obligations preserves matching evidence and removes only the removed obligation", () => {
  const complete = delivered(attestation(first), attestation(second));
  const withRequirements = (requirements: readonly (typeof first)[]) => ({
    ...complete,
    terms: { ...complete.terms, requirements: { [selectedGate]: requirements } },
  });
  assert.equal(gateReports(withRequirements([second, first])).satisfied, true);
  assert.equal(gateReports(withRequirements([first, requirementId("new")])).satisfied, false);
  assert.equal(gateReports(withRequirements([second])).satisfied, true);
  assert.equal(gateReports(withRequirements([second])).reports[0]!.requirements.length, 1);
});

test("durable terms require nonempty exact gate requirements and attestations require an opaque identity", () => {
  const original = bind();
  assert.deepEqual(decodeJournal(encodeEntry(original)), [original]);
  for (const requirements of [{}, { checks: [] }, { checks: [first, first] }, { checks: [first], extra: [second] }]) {
    assert.throws(
      () => validateEntry({ ...original, data: { ...original.data, terms: { ...original.data.terms, requirements } } }),
      /requirements/,
    );
  }
  const testimony = entry("attestation", attestation(first), 2);
  assert.deepEqual(decodeJournal(encodeEntry(testimony)), [testimony]);
  const { requirement: omitted, ...incomplete } = testimony.data;
  void omitted;
  assert.throws(() => validateEntry({ ...testimony, data: incomplete }), /missing field 'requirement'/);
});
