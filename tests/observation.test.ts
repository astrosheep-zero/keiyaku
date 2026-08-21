import assert from "node:assert/strict";
import test from "node:test";
import { contractState } from "../src/core/facts/observation.js";
import { decideBind } from "../src/core/verbs/bind.js";
import { decideAmend } from "../src/core/verbs/amend.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  changeId,
  contractId,
  documentKey,
  entryUlid,
  snapshotId,
} from "../src/core/facts/types.js";

const id = contractId("kei/observation-test");
const dependency = contractId("kei/observation-dependency");

function terms(after: readonly ReturnType<typeof contractId>[] = []) {
  return {
    document: { bytes: "# Observation\n", key: documentKey("observation") },
    segments: [],
    gates: [],
    after,
  };
}

function waitingState(contract: ReturnType<typeof contractId>, after: readonly ReturnType<typeof contractId>[] = []) {
  return foldJournal(contract, [{
    v: 1,
    kind: "bind",
    contract,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: "2026-08-07T00:00:00Z",
    data: {
      coordinates: { start: snapshotId("start"), workspace: "worktree" },
      terms: terms(after),
    },
  }]);
}

function deliveredState(contract: ReturnType<typeof contractId>, after: readonly ReturnType<typeof contractId>[] = []) {
  return foldJournal(contract, [
    {
      v: 1,
      kind: "bind",
      contract,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      at: "2026-08-07T00:00:00Z",
      data: {
        coordinates: { start: snapshotId("start"), workspace: "worktree" },
        terms: terms(after),
      },
    },
    {
      v: 1,
      kind: "bound",
      contract,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      at: "2026-08-07T00:00:01Z",
      data: {},
    },
    {
      v: 1,
      kind: "deliver",
      contract,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      at: "2026-08-07T00:00:02Z",
      data: {
        tenderSnapshot: snapshotId("tender"),
        integration: {
          predecessor: snapshotId("predecessor"),
          snapshot: snapshotId("snapshot"),
          changeId: changeId("change"),
        },
        method: "squash",
        policy: { requireBranchesToBeUpToDate: false },
      },
    },
  ]);
}

function terminalState(
  contract: ReturnType<typeof contractId>,
  terminal: "claimed" | "abandoned",
) {
  const delivered = deliveredState(contract);
  return {
    ...delivered,
    terminal: terminal === "claimed"
      ? {
        v: 1 as const,
        kind: "claimed" as const,
        contract,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
        at: "2026-08-07T00:00:03Z",
        data: { delivery: delivered.delivery!.entry },
      }
      : {
        v: 1 as const,
        kind: "abandoned" as const,
        contract,
        entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY"),
        at: "2026-08-07T00:00:03Z",
        data: {},
      },
  };
}

test("decision accessor rejects a missing key, while explicit null is domain absence", () => {
  assert.throws(
    () => contractState(new Map(), id),
    (error: unknown) => error instanceof Error
      && !(error instanceof TypeError)
      && error.message.includes("missing contract decision observation"),
  );
  assert.throws(
    () => decideAmend({
      input: {
        contractId: id,
        at: "2026-08-07T00:00:00Z",
        source: terms(),
        preparation: { kind: "prepared", data: terms() },
      },
      attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
      observation: new Map([[dependency, null]]),
    }),
    (error: unknown) => error instanceof Error
      && !(error instanceof TypeError)
      && error.message.includes("missing contract decision observation"),
  );

  const observation = new Map<typeof id | typeof dependency, null>([
    [id, null],
    [dependency, null],
  ]);
  const amend = decideAmend({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:00Z",
      source: terms(),
      preparation: { kind: "prepared", data: terms() },
    },
    attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
    observation,
  });
  assert.deepEqual(amend, { kind: "refused", refusal: { kind: "contract-missing", contractId: id } });

  const bind = decideBind({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:00Z",
      preparation: {
        kind: "prepared",
        data: {
          coordinates: { start: snapshotId("start"), workspace: "worktree" },
          terms: terms([dependency]),
        },
      },
    },
    attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV")] },
    observation,
  });
  assert.deepEqual(bind, { kind: "refused", refusal: { kind: "unknown-prerequisite", contractId: id } });
});

test("placement projects every non-claimed prerequisite from its one observation", () => {
  const active = contractId("kei/active-prerequisite");
  const abandoned = contractId("kei/abandoned-prerequisite");
  const claimed = contractId("kei/claimed-prerequisite");
  const missing = contractId("kei/missing-prerequisite");
  const dependent = deliveredState(id, [active, abandoned, claimed, missing]);

  const decision = decidePlacement({
    input: { contractId: id, at: "2026-08-07T00:00:04Z" },
    attempt: { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ")] },
    observation: new Map([
      [id, dependent],
      [active, waitingState(active)],
      [abandoned, terminalState(abandoned, "abandoned")],
      [claimed, terminalState(claimed, "claimed")],
      [missing, null],
    ]),
  });

  assert.deepEqual(decision, {
    kind: "refused",
    refusal: {
      kind: "prerequisites-unsatisfied",
      contractId: id,
      unmet: [
        { contractId: active, state: "active" },
        { contractId: abandoned, state: "abandoned" },
        { contractId: missing, state: "missing" },
      ],
    },
  });
});

test("the decision map cannot carry a disagreeing state identity", () => {
  const other = contractId("kei/other-observation");
  const state = foldJournal(other, [{
    v: 1,
    kind: "bind",
    contract: other,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: "2026-08-07T00:00:00Z",
    data: {
      coordinates: { start: snapshotId("start"), workspace: "worktree" },
      terms: terms(),
    },
  }]);
  assert.throws(
    () => contractState(new Map([[id, state]]), id),
    (error: unknown) => error instanceof Error
      && !(error instanceof TypeError)
      && error.message.includes("disagrees with decision map"),
  );
});

test("amend refuses direct and transitive prerequisite cycles", () => {
  const a = contractId("kei/cycle-a");
  const b = contractId("kei/cycle-b");
  const c = contractId("kei/cycle-c");
  const current = waitingState(a, [c]);
  const attempt = { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY")] };
  const decide = (after: readonly ReturnType<typeof contractId>[]) => decideAmend({
    input: {
      contractId: a,
      at: "2026-08-07T00:00:01Z",
      source: current.terms,
      preparation: { kind: "prepared" as const, data: terms(after) },
    },
    attempt,
    observation: new Map([
      [a, current],
      [b, waitingState(b, [a])],
      [c, waitingState(c)],
    ]),
  });

  const refusal = { kind: "refused", refusal: { kind: "cyclic-prerequisite", contractId: a } };
  assert.deepEqual(decide([a]), refusal);
  assert.deepEqual(decide([b]), refusal);
});

test("lifecycle and document refusals outrank a refused preparation", () => {
  const bind = {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: "2026-08-07T00:00:00Z",
    data: {
      coordinates: { start: snapshotId("start"), workspace: "worktree" },
      terms: terms(),
    },
  };
  const bound = foldJournal(id, [bind]);
  const active = foldJournal(id, [
    bind,
    {
      v: 1,
      kind: "bound",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      at: "2026-08-07T00:00:01Z",
      data: {},
    },
  ]);
  const terminal = foldJournal(id, [
    bind,
    {
      v: 1,
      kind: "bound",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      at: "2026-08-07T00:00:01Z",
      data: {},
    },
    {
      v: 1,
      kind: "abandoned",
      contract: id,
      entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      at: "2026-08-07T00:00:02Z",
      data: {},
    },
  ]);
  const attempt = { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAY")] };
  const mechanical = { kind: "mechanical" };

  assert.deepEqual(decideBind({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:02Z",
      preparation: { kind: "refused", refusal: mechanical },
    },
    attempt,
    observation: new Map([[id, active]]),
  }), { kind: "refused", refusal: { kind: "contract-exists", contractId: id } });
  assert.deepEqual(decideAmend({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:02Z",
      source: { ...active.terms, document: { ...active.terms.document, key: documentKey("stale") } },
      preparation: { kind: "refused", refusal: mechanical },
    },
    attempt,
    observation: new Map([[id, active]]),
  }), { kind: "refused", refusal: { kind: "terms-moved", contractId: id } });
  assert.deepEqual(decideDeliver({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:02Z",
      preparation: { kind: "refused", document: documentKey("stale"), refusal: mechanical },
    },
    attempt,
    observation: new Map([[id, active]]),
  }), { kind: "refused", refusal: { kind: "document-moved", contractId: id } });
  assert.deepEqual(decideAttestation({
    input: {
      contractId: id,
      at: "2026-08-07T00:00:02Z",
      preparation: { kind: "refused", refusal: mechanical },
    },
    attempt,
    observation: new Map([[id, terminal]]),
  }), { kind: "refused", refusal: { kind: "terminal", contractId: id } });
});
