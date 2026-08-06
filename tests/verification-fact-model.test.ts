import assert from "node:assert/strict";
import test from "node:test";
import { decodeEntry, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { gateSatisfied, verificationDeclarationKey } from "../src/core/facts/gate.js";
import { changeId, contractId, declarationKey, entryUlid, snapshotId, type ContractBody, type JournalEntry } from "../src/core/facts/types.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { decideVerification } from "../src/core/verbs/verification.js";

const id = contractId("kei/verification-facts");
const base = snapshotId("a".repeat(40));
const candidate = snapshotId("b".repeat(40));
const replacementCandidate = snapshotId("c".repeat(40));
const body: ContractBody = {
  title: "Verification",
  context: "context",
  objective: "objective",
  design: "design",
  region: ["src"],
  criteria: [{ title: "criterion", body: "criterion" }],
  verification: [{ executor: "bash", script: "true" }],
  gates: ["verified"],
  extensions: [],
};

function fact<K extends JournalEntry["kind"]>(kind: K, data: Extract<JournalEntry, { kind: K }>["data"], suffix: string): Extract<JournalEntry, { kind: K }> {
  return {
    v: 1,
    kind,
    contract: id,
    entry: entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`),
    at: "2026-08-05T00:00:00Z",
    actor: "tester",
    data,
  } as Extract<JournalEntry, { kind: K }>;
}

function deliveredEntries(): readonly JournalEntry[] {
  return [
    fact("bind", { coordinates: { start: base, target: "refs/heads/main", workspace: "worktree" }, body }, "01"),
    fact("bound", {}, "02"),
    fact("deliver", {
      expectedPredecessor: base,
      candidate,
      deliveryPatchId: changeId("d".repeat(40)),
    }, "03"),
  ];
}

function observation(entries: readonly JournalEntry[]) {
  return {
    carrierSnapshot: null,
    contracts: new Map([[id, { id, entries, state: foldJournal(id, entries) }]]),
  };
}

test("codec accepts only the separate validated verification fact", () => {
  const key = verificationDeclarationKey(body.verification);
  assert.equal(key, "3a2fd16dad18d9cca417316432eb0c9f75ad2e1d95187be5494ca07e56a817d1");
  const verification = fact("verification", { candidate, declarationKey: key, result: "pass", summary: "passed" }, "04");
  assert.deepEqual(decodeEntry(encodeEntry(verification)), verification);

  const deliver = deliveredEntries()[2]!;
  const nestedResult = encodeEntry(deliver).replace(",\"deliveryPatchId\"", ",\"verification\":{\"result\":\"pass\"},\"deliveryPatchId\"");
  assert.throws(() => decodeEntry(nestedResult), /data\.deliver: unknown field 'verification'/);
  const malformedKey = encodeEntry(verification).replace(key, "0".repeat(63));
  assert.throws(() => decodeEntry(malformedKey), /data\.verification\.declarationKey/);
});

test("verified gate is keyed by current candidate and declarations, with latest fact winning", () => {
  const key = verificationDeclarationKey(body.verification);
  const pass = fact("verification", { candidate, declarationKey: key, result: "pass" }, "04");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), pass]), "verified"), true);

  const unrelatedAmend = fact("amend", { ...body, title: "Updated prose" }, "05");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), pass, unrelatedAmend]), "verified"), true);

  const verificationAmend = fact("amend", { ...body, verification: [{ executor: "bash", script: "false" }] }, "06");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), pass, verificationAmend]), "verified"), false);

  const replacementDeliver = fact("deliver", {
    expectedPredecessor: base,
    candidate: replacementCandidate,
    deliveryPatchId: changeId("e".repeat(40)),
  }, "07");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), pass, replacementDeliver]), "verified"), false);

  const fail = fact("verification", { candidate, declarationKey: key, result: "fail" }, "08");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), pass, fail]), "verified"), false);
});

test("delivery records a candidate and explicit placement claims", () => {
  const noVerificationBody = { ...body, verification: [], gates: [] } satisfies ContractBody;
  const entries: readonly JournalEntry[] = [
    fact("bind", { coordinates: { start: base, target: "refs/heads/main", workspace: "worktree" }, body: noVerificationBody }, "01"),
    fact("bound", {}, "02"),
  ];
  const decision = decideDeliver({
    input: {
      contractId: id,
      actor: "tester",
      at: "2026-08-05T00:00:00Z",
      data: { expectedPredecessor: base, candidate, deliveryPatchId: changeId("d".repeat(40)) },
    },
    attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F09"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0A")] },
    observation: observation(entries),
  });
  assert.equal(decision.kind, "offer");
  if (decision.kind !== "offer") return;
  assert.deepEqual(decision.offer.facts[0]!.entries.map((entry) => entry.kind), ["deliver"]);
  assert.equal(decision.offer.target, undefined);

  const acceptedEntries = [...entries, decision.offer.facts[0]!.entries[0]!];
  const placement = decidePlacement({
    input: { contractId: id, at: "2026-08-05T00:00:00Z" },
    attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0B")] },
    observation: observation(acceptedEntries),
  });
  assert.equal(placement.kind, "offer");
  if (placement.kind !== "offer") return;
  assert.deepEqual(placement.offer.facts[0]!.entries.map((entry) => entry.kind), ["claimed"]);
  assert.deepEqual(placement.offer.target, { target: "refs/heads/main", expectedOid: base, newOid: candidate });
});

test("targetless placement claims through the journal without a ref operation", () => {
  const noVerificationBody = { ...body, verification: [], gates: [] } satisfies ContractBody;
  const entries: readonly JournalEntry[] = [
    fact("bind", { coordinates: { start: base, workspace: "here" }, body: noVerificationBody }, "01"),
    fact("bound", {}, "02"),
    fact("deliver", { expectedPredecessor: base, candidate, deliveryPatchId: changeId("d".repeat(40)) }, "03"),
  ];
  const placement = decidePlacement({
    input: { contractId: id, at: "2026-08-05T00:00:00Z" },
    attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0B")] },
    observation: observation(entries),
  });
  assert.equal(placement.kind, "offer");
  if (placement.kind !== "offer") return;
  assert.deepEqual(placement.offer.facts[0]!.entries.map((entry) => entry.kind), ["claimed"]);
  assert.equal(placement.offer.target, undefined);
  assert.equal("actor" in placement.offer.facts[0]!.entries[0]!, false);
});

test("verification decision records only its matching fact and refuses stale input", () => {
  const key = verificationDeclarationKey(body.verification);
  const input = { contractId: id, actor: "tester", at: "2026-08-05T00:00:00Z", data: { candidate, declarationKey: key, result: "pass" as const } };
  const attempt = { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F09"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0A")] };
  const accepted = decideVerification({ input, attempt, observation: observation(deliveredEntries()) });
  assert.equal(accepted.kind, "offer");
  if (accepted.kind !== "offer") return;
  assert.deepEqual(accepted.offer.facts[0]!.entries.map((entry) => entry.kind), ["verification"]);
  assert.equal(accepted.offer.target, undefined);

  const candidateMismatch = decideVerification({
    input: { ...input, data: { ...input.data, candidate: replacementCandidate } },
    attempt,
    observation: observation(deliveredEntries()),
  });
  assert.deepEqual(candidateMismatch, {
    kind: "refused",
    refusal: { kind: "candidate-mismatch", contractId: id, candidate: replacementCandidate, deliveryCandidate: candidate },
  });

  const declarationMismatch = decideVerification({
    input: { ...input, data: { ...input.data, declarationKey: declarationKey("0".repeat(64)) } },
    attempt,
    observation: observation(deliveredEntries()),
  });
  assert.deepEqual(declarationMismatch, {
    kind: "refused",
    refusal: { kind: "declaration-mismatch", contractId: id, declarationKey: declarationKey("0".repeat(64)), effectiveDeclarationKey: key },
  });

  const noDelivery = decideVerification({
    input,
    attempt,
    observation: observation(deliveredEntries().slice(0, 2)),
  });
  assert.deepEqual(noDelivery, { kind: "refused", refusal: { kind: "delivery-missing", contractId: id } });

  const pass = fact("verification", { candidate, declarationKey: key, result: "pass" }, "04");
  const claimed = fact("claimed", { delivery: deliveredEntries()[2]!.entry }, "05");
  const terminal = decideVerification({ input, attempt, observation: observation([...deliveredEntries(), pass, claimed]) });
  assert.deepEqual(terminal, { kind: "refused", refusal: { kind: "terminal", contractId: id } });
});

test("latest matching review verdict overrides an earlier approval", () => {
  const approved = fact("review", {
    verdict: "approved",
    reviewedPatchId: changeId("d".repeat(40)),
    reviewedHead: candidate,
  }, "09");
  const changesRequested = fact("review", {
    verdict: "changes-requested",
    reviewedPatchId: changeId("d".repeat(40)),
    reviewedHead: candidate,
  }, "0A");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), approved]), "reviewed"), true);
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), approved, changesRequested]), "reviewed"), false);
});
