import assert from "node:assert/strict";
import test from "node:test";
import { dependencyKeySet } from "../src/core/subject.js";
import { gateReports, gatesSatisfied } from "../src/core/facts/gate.js";
import {
  changeId,
  contractId,
  documentKey,
  documentSegmentKey,
  entryUlid,
  gate,
  snapshotId,
  type ContractState,
} from "../src/core/facts/types.js";

function state(candidate: string, document = "document-1"): ContractState {
  const id = contractId("kei/currentness");
  const patch = changeId("patch-1");
  const documentKeyValue = documentKey(document);
  const segment = documentSegmentKey("verification-1");
  const delivery = {
    v: 1 as const,
    kind: "deliver" as const,
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: "2026-08-06T00:00:00Z",
    data: {
      tenderSnapshot: snapshotId(candidate),
      integration: { predecessor: snapshotId("base"), snapshot: snapshotId(candidate), changeId: patch },
      method: "squash",
      policy: { requireBranchesToBeUpToDate: false },
    },
  };
  return {
    id,
    head: null,
    coordinates: { start: snapshotId("base"), workspace: "here" },
    terms: {
      document: { bytes: "# Current", key: documentKeyValue },
      segments: [segment],
      gates: [gate("reviewed"), gate("verified")],
      after: [],
    },
    bound: null,
    delivery,
    attestations: [
      {
        v: 1,
        kind: "attestation",
        contract: id,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        at: "2026-08-06T00:00:01Z",
        data: {
          gate: gate("reviewed"),
          subject: dependencyKeySet([
            { kind: "document", value: documentKeyValue },
            { kind: "change", value: patch },
          ]),
          verdict: "satisfied",
        },
      },
      {
        v: 1,
        kind: "attestation",
        contract: id,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAB"),
        at: "2026-08-06T00:00:02Z",
        data: {
          gate: gate("verified"),
          subject: dependencyKeySet([
            { kind: "segment", value: segment },
            { kind: "snapshot", value: snapshotId("candidate-a") },
          ]),
          verdict: "satisfied",
        },
      },
    ],
    terminal: null,
  };
}

function oneGateSatisfied(current: ContractState, selected: ReturnType<typeof gate>): boolean {
  return gatesSatisfied({
    ...current,
    terms: { ...current.terms, gates: [selected] },
  });
}

test("review currentness survives a clean rebase while verification stays candidate-bound", () => {
  const rebased = state("candidate-b");
  assert.equal(oneGateSatisfied(rebased, gate("reviewed")), true);
  assert.equal(oneGateSatisfied(rebased, gate("verified")), false);
});

test("verification currentness survives an Objective-only document change", () => {
  const objectiveAmended = state("candidate-a", "document-2");
  assert.equal(oneGateSatisfied(objectiveAmended, gate("verified")), true);
});

test("document and segment subjects are current before any delivery exists", () => {
  const current = state("candidate-a");
  const documentOnly = gate("document-only");
  const preDelivery: ContractState = {
    ...current,
    terms: { ...current.terms, gates: [documentOnly] },
    delivery: null,
    attestations: [{
      ...current.attestations[0]!,
      data: {
        gate: documentOnly,
        subject: dependencyKeySet([
          { kind: "document", value: current.terms.document.key },
          { kind: "segment", value: current.terms.segments[0]! },
        ]),
        verdict: "satisfied",
      },
    }],
  };

  assert.equal(oneGateSatisfied(preDelivery, documentOnly), true);
  assert.equal(gatesSatisfied(preDelivery), true);
});

test("gates use the latest testimony for the same current subject", () => {
  const current = state("candidate-a");
  const latestVerification = current.attestations[1]!;
  const superseded = {
    ...current,
    attestations: [
      ...current.attestations,
      {
        ...latestVerification,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAC"),
        data: { ...latestVerification.data, verdict: "unsatisfied" as const },
      },
    ],
  };

  assert.equal(oneGateSatisfied(superseded, gate("verified")), false);
  assert.equal(gatesSatisfied(superseded), false);
});

test("generic gates accept testimony for any current subject", () => {
  const current = state("candidate-a");
  const verified = gate("verified");
  const unrelated = dependencyKeySet([
    { kind: "document", value: current.terms.document.key },
  ]);
  const withUnrelatedLatest: ContractState = {
    ...current,
    attestations: [{
      ...current.attestations[1]!,
      data: { gate: verified, subject: unrelated, verdict: "satisfied" },
    }],
  };

  assert.equal(oneGateSatisfied(withUnrelatedLatest, verified), true);
});

test("gates skip later testimony for stale subjects", () => {
  const current = state("candidate-a");
  const latestVerification = current.attestations[1]!;
  const stale = {
    ...current,
    attestations: [
      ...current.attestations,
      {
        ...latestVerification,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAD"),
        data: {
          ...latestVerification.data,
          subject: dependencyKeySet([
            { kind: "segment", value: documentSegmentKey("verification-1") },
            { kind: "snapshot", value: snapshotId("candidate-old") },
          ]),
          verdict: "unsatisfied" as const,
        },
      },
    ],
  };

  assert.equal(oneGateSatisfied(stale, gate("verified")), true);
  assert.equal(gatesSatisfied(stale), true);
});

test("one currency projection distinguishes current refusal, stale testimony, and missing testimony", () => {
  const current = state("candidate-b");
  const latestReview = current.attestations[0]!;
  const projected = gateReports({
    ...current,
    terms: { ...current.terms, gates: [...current.terms.gates, gate("manual")] },
    attestations: [
      ...current.attestations,
      {
        ...latestReview,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAE"),
        data: { ...latestReview.data, verdict: "unsatisfied" },
      },
    ],
  });

  assert.deepEqual(projected, {
    reports: [
      { gate: "reviewed", current: { kind: "attested", verdict: "unsatisfied" } },
      { gate: "verified", current: { kind: "stale", priorVerdict: "satisfied" } },
      { gate: "manual", current: { kind: "missing" } },
    ],
    satisfied: false,
  });
});
