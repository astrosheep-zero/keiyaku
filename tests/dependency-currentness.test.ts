import assert from "node:assert/strict";
import test from "node:test";
import { dependencyKeySet } from "../src/core/subject.js";
import { gatesSatisfied } from "../src/core/facts/gate.js";
import {
  changeId,
  contractId,
  documentKey,
  documentSegmentKey,
  entryUlid,
  gate,
  snapshotId,
  type ContractState,
  type JournalEntry,
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
  } satisfies Extract<JournalEntry, { kind: "deliver" }>;
  return {
    id,
    head: null,
    coordinates: { start: snapshotId("base"), workspace: "worktree" },
    terms: {
      document: { bytes: "# Current", key: documentKeyValue },
      segments: [segment],
      gates: [gate("reviewed"), gate("verified")],
      after: [],
    },
    bound: null,
    delivery,
    currentIntegration: null,
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
