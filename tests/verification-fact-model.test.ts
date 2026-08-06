import assert from "node:assert/strict";
import test from "node:test";
import { verificationDeclarationKey } from "../src/core/declaration-key.js";
import { decodeEntry, encodeEntry, FactsCodecError } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { gateSatisfied } from "../src/core/facts/gate.js";
import { currentSubject } from "../src/core/subject.js";
import { changeId, contractId, entryUlid, snapshotId, type AttestationData, type ContractBody, type Gate, type JournalEntry } from "../src/core/facts/types.js";
import { decideDeliver } from "../src/core/verbs/deliver.js";
import { decidePlacement } from "../src/core/verbs/placement.js";
import { decideAttestation } from "../src/core/verbs/attestation.js";

const id = contractId("kei/attestation-facts");
const base = snapshotId("a".repeat(40));
const candidate = snapshotId("b".repeat(40));
const replacementCandidate = snapshotId("c".repeat(40));
const body: ContractBody = {
  title: "Attestation",
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
    fact("deliver", { expectedPredecessor: base, candidate, deliveryPatchId: changeId("d".repeat(40)) }, "03"),
  ];
}

function observation(entries: readonly JournalEntry[]) {
  return { carrierSnapshot: null, contracts: new Map([[id, { id, entries, state: foldJournal(id, entries) }]]) };
}

function captured(gate: Gate, verdict: AttestationData["verdict"], entries: readonly JournalEntry[] = deliveredEntries()): AttestationData {
  const subject = currentSubject(foldJournal(id, entries), gate);
  if (subject === null) throw new Error("test attestation requires a current subject");
  return { gate, subject, verdict };
}

function attestation(gate: Gate, verdict: AttestationData["verdict"], suffix: string, entries: readonly JournalEntry[] = deliveredEntries()) {
  return fact("attestation", captured(gate, verdict, entries), suffix);
}

test("verification declaration keys use the canonical ordered declaration bytes", () => {
  assert.equal(
    verificationDeclarationKey([{ executor: "bash", script: "true" }]),
    "3a2fd16dad18d9cca417316432eb0c9f75ad2e1d95187be5494ca07e56a817d1",
  );
});

test("codec accepts only the attestation fact vocabulary", () => {
  const verified = attestation("verified", "satisfied", "04");
  assert.deepEqual(decodeEntry(encodeEntry(verified)), verified);

  const unknown = { ...verified, kind: "obsolete" };
  assert.throws(() => decodeEntry(JSON.stringify(unknown)), /unknown journal entry kind/);
  const malformedSubject = { ...verified, data: { ...verified.data, subject: "A".repeat(64) } };
  assert.throws(
    () => decodeEntry(JSON.stringify(malformedSubject)),
    (error: unknown) => error instanceof FactsCodecError && /data\.attestation\.subject/.test(error.message),
  );
  const blankActor = { ...verified, actor: " " };
  assert.throws(() => decodeEntry(JSON.stringify(blankActor)), /expected a nonblank string/);
});

test("verified attestation remains current after an unrelated Context amendment", () => {
  const verified = attestation("verified", "satisfied", "04");
  const contextAmend = fact("amend", { ...body, context: "Updated Context" }, "05");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), verified, contextAmend]), "verified"), true);
});

test("reviewed attestation is invalidated by Objective or Criteria amendments", () => {
  const reviewed = attestation("reviewed", "satisfied", "06");
  const objectiveAmend = fact("amend", { ...body, objective: "Updated Objective" }, "07");
  const criteriaAmend = fact("amend", { ...body, criteria: [{ title: "criterion", body: "Updated Criteria" }] }, "08");
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), reviewed]), "reviewed"), true);
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), reviewed, objectiveAmend]), "reviewed"), false);
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), reviewed, criteriaAmend]), "reviewed"), false);
});

test("same-subject unsatisfied attestation supersedes a satisfied one", () => {
  const satisfied = attestation("verified", "satisfied", "09");
  const unsatisfied = attestation("verified", "unsatisfied", "0A", [...deliveredEntries(), satisfied]);
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), satisfied]), "verified"), true);
  assert.equal(gateSatisfied(foldJournal(id, [...deliveredEntries(), satisfied, unsatisfied]), "verified"), false);
});

test("delivery records a candidate and explicit placement claims", () => {
  const noVerificationBody = { ...body, verification: [], gates: [] } satisfies ContractBody;
  const entries: readonly JournalEntry[] = [
    fact("bind", { coordinates: { start: base, target: "refs/heads/main", workspace: "worktree" }, body: noVerificationBody }, "01"),
    fact("bound", {}, "02"),
  ];
  const decision = decideDeliver({
    input: { contractId: id, actor: "tester", at: "2026-08-05T00:00:00Z", data: { expectedPredecessor: base, candidate, deliveryPatchId: changeId("d".repeat(40)) } },
    attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F09"), entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0A")] },
    observation: observation(entries),
  });
  assert.equal(decision.kind, "offer");
  if (decision.kind !== "offer") return;
  const acceptedEntries = [...entries, decision.offer.facts[0]!.entries[0]!];
  const placement = decidePlacement({
    input: { contractId: id, at: "2026-08-05T00:00:00Z" },
    attempt: { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0B")] },
    observation: observation(acceptedEntries),
  });
  assert.equal(placement.kind, "offer");
  if (placement.kind !== "offer") return;
  assert.deepEqual(placement.offer.facts[0]!.entries.map((entry) => entry.kind), ["claimed"]);
});

test("review and verification reject a captured subject after state changes", () => {
  const entries = deliveredEntries();
  const reviewedAttestation = captured("reviewed", "satisfied", entries) as AttestationData & Readonly<{ gate: "reviewed" }>;
  const verifiedAttestation = captured("verified", "satisfied", entries) as AttestationData & Readonly<{ gate: "verified" }>;
  const attempt = { ordinal: 0, entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5F0C")] };
  const objectiveAmend = fact("amend", { ...body, objective: "Changed while reviewing" }, "0D");
  const review = decideAttestation({
    input: { contractId: id, actor: "tester", at: "2026-08-05T00:00:00Z", data: reviewedAttestation },
    attempt,
    observation: observation([...entries, objectiveAmend]),
  });
  assert.equal(review.kind, "refused");
  if (review.kind === "refused") assert.equal(review.refusal.kind, "stale-subject");

  const replacement = fact("deliver", { expectedPredecessor: base, candidate: replacementCandidate, deliveryPatchId: changeId("e".repeat(40)) }, "0E");
  const verification = decideAttestation({
    input: { contractId: id, actor: "tester", at: "2026-08-05T00:00:00Z", data: verifiedAttestation },
    attempt,
    observation: observation([...entries, replacement]),
  });
  assert.equal(verification.kind, "refused");
  if (verification.kind === "refused") assert.equal(verification.refusal.kind, "stale-subject");
});
