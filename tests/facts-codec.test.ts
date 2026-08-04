import assert from "node:assert/strict";
import test from "node:test";
import {
  FactsCodecError,
  NonCanonicalEntryError,
  UnknownEntryError,
  appendEntry,
  bodyDigest,
  canonicalJson,
  decodeEntry,
  decodeJournal,
  encodeEntry,
} from "../src/core/facts/codec.js";
import {
  blobOid,
  commitOid,
  contractHead,
  contractId,
  contractJournalPath,
  evidencePath,
  entryUlid,
  type BindEntry,
  type JournalEntry,
} from "../src/core/facts/types.js";
import { effectiveBody, foldEntry, foldJournal } from "../src/core/facts/fold.js";

const contract = contractId("kei/facts-contract");
const oid = (last = "a"): ReturnType<typeof blobOid> => blobOid(last.repeat(40));
const commit = (last = "b"): ReturnType<typeof commitOid> => commitOid(last.repeat(40));
const ulid = (last: string): ReturnType<typeof entryUlid> => entryUlid(`01J${"0".repeat(22)}${last.toUpperCase()}`);
const at = "2026-08-03T00:00:00Z";

const bind: BindEntry = {
  v: 1,
  kind: "bind",
  contract,
  entry: ulid("1"),
  at,
  actor: "tester",
  data: {
    title: "Facts contract",
    context: "Context",
    objective: "Objective",
    design: "Design",
    region: ["src/**"],
    criteria: ["green"],
    verification: [{ executor: "bash", script: "true" }],
    extensions: [],
  },
};

const evidence = (entry: ReturnType<typeof entryUlid>, kind: string, value = "c") => ({
  entry,
  seq: 0,
  kind,
  oid: oid(value),
});

function entry<K extends JournalEntry["kind"]>(value: Extract<JournalEntry, { kind: K }>): Extract<JournalEntry, { kind: K }> {
  return value;
}

function seal(entryId: string) {
  return entry({ v: 1, kind: "seal", contract, entry: ulid(entryId), at, actor: "tester", data: {} });
}

function open(entryId: string) {
  return entry({ v: 1, kind: "open", contract, entry: ulid(entryId), at, actor: "tester", data: { target: "refs/heads/main", base: commit("a") } });
}

function claimPetition(entryId: string, candidate = "1") {
  return entry({
    v: 1,
    kind: "petition",
    contract,
    entry: ulid(entryId),
    at,
    actor: "tester",
    data: { expectedPredecessor: commit("f"), deliveryHead: commit("a"), candidate: commit(candidate) },
  });
}

function review(entryId: string, verdict: "approved" | "changes-requested" = "approved") {
  const reviewId = ulid(entryId);
  return entry({
    v: 1,
    kind: "review",
    contract,
    entry: reviewId,
    at,
    actor: "reviewer",
    data: verdict === "approved"
      ? { verdict, reviewedHead: commit("a"), digest: "sha256:review", summary: "reviewed", evidence: [evidence(reviewId, "review")] }
      : { verdict, digest: "sha256:review", summary: "reviewed", evidence: [evidence(reviewId, "review")] },
  });
}

function claimedJournal(): JournalEntry[] {
  return [
    bind,
    entry({
      v: 1, kind: "amend", contract, entry: ulid("2"), at, actor: "tester",
      data: { revisions: [{ target: "objective", op: "append", body: "Second objective" }] },
    }),
    open("G"),
    seal("3"),
    claimPetition("4"),
    review("5"),
    entry({ v: 1, kind: "claim", contract, entry: ulid("6"), at, actor: "tester", data: { petition: ulid("4") } }),
  ];
}

test("all native v1 journal entries have exact canonical JSONL round trips", () => {
  const reviewEntry = ulid("7");
  const entries: JournalEntry[] = [
    bind,
    entry({
      v: 1, kind: "amend", contract, entry: ulid("8"), at, actor: "tester",
      data: { verificationDelta: { replace: [{ executor: "zsh", script: "true" }] } },
    }),
    entry({ v: 1, kind: "seal", contract, entry: ulid("9"), at, actor: "tester", data: {} }),
    entry({
      v: 1, kind: "open", contract, entry: ulid("A"), at, actor: "tester",
      data: { target: "refs/heads/main", base: commit("c") },
    }),
    entry({
      v: 1, kind: "renew", contract, entry: ulid("B"), at, actor: "tester",
      data: { newBase: commit("d"), oldHead: commit("e"), newHead: commit("f") },
    }),
    entry({
      v: 1, kind: "petition", contract, entry: ulid("C"), at, actor: "tester",
      data: { expectedPredecessor: commit("f"), deliveryHead: commit("a"), candidate: commit("1") },
    }),
    entry({
      v: 1, kind: "forfeit", contract, entry: ulid("G"), at, actor: "tester",
      data: { reason: "manual", note: "stopped by holder" },
    }),
    entry({
      v: 1, kind: "review", contract, entry: reviewEntry, at, actor: "tester",
      data: { verdict: "approved", reviewedHead: commit("a"), digest: "sha256:review", summary: "approved", evidence: [evidence(reviewEntry, "review")] },
    }),
    entry({
      v: 1, kind: "check", contract, entry: ulid("D"), at, actor: "tester",
      data: { result: "pass", summary: "checked", evidence: [evidence(ulid("D"), "check", "d")] },
    }),
    entry({
      v: 1, kind: "verification", contract, entry: ulid("E"), at, actor: "tester",
      data: { result: "pass", summary: "verified", evidence: [evidence(ulid("E"), "verification", "e")] },
    }),
    entry({ v: 1, kind: "claim", contract, entry: ulid("F"), at, actor: "tester", data: { petition: ulid("C") } }),
  ];

  let journal = "";
  for (const value of entries) {
    const encoded = encodeEntry(value);
    assert.equal(encoded, `${canonicalJson(value)}\n`);
    assert.deepEqual(decodeEntry(encoded), value);
    journal = appendEntry(journal, value);
  }
  assert.equal(journal, entries.map((value) => encodeEntry(value)).join(""));
  assert.deepEqual(decodeJournal(journal), entries);
});

test("canonical JSON sorts object keys and preserves array order", () => {
  assert.equal(canonicalJson({ z: 1, a: ["second", "first"] }), '{"a":["second","first"],"z":1}');
  assert.equal(bodyDigest(bind.data), bodyDigest({ ...bind.data, extensions: [...bind.data.extensions] }));
});

test("unknown fields, kinds, versions, and unsafe identities fail closed", () => {
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "future" })), UnknownEntryError);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "__proto__" })), UnknownEntryError);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, v: 6 })), /expected version 1 for bind/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, contract: "../unsafe" })), FactsCodecError);
  assert.throws(() => decodeEntry(canonicalJson({
    ...bind,
    kind: "check",
    entry: ulid("G"),
    data: { result: "pass", summary: "checked", evidence: [{ ...evidence(ulid("G"), "../unsafe") }] },
  })), FactsCodecError);
  assert.throws(() => decodeEntry(canonicalJson({
    ...bind,
    kind: "amend",
    entry: ulid("H"),
    data: { verificationDelta: { replace: [], extra: true } },
  })), /unknown field 'extra'/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "evidence-lost", data: {} })), UnknownEntryError);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "seal", data: { sealedBy: "petition" } })), FactsCodecError);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "open", entry: ulid("J"), data: { target: "refs/heads/main" } })), /missing field 'base'/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "renew", entry: ulid("K"), data: { oldHead: commit("a"), newHead: commit("b") } })), /missing field 'newBase'/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "petition", entry: ulid("N"), data: { expectedPredecessor: commit("a"), deliveryHead: commit("a"), candidate: commit("b"), intent: "claim" } })), /unknown field 'intent'/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "petition", entry: ulid("P"), data: { expectedPredecessor: commit("a"), candidate: commit("b") } })), /missing field 'deliveryHead'/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "review", entry: ulid("M"), data: { verdict: "approved", digest: "digest", summary: "approved", evidence: [] } })), /missing field 'reviewedHead'/);
  assert.throws(() => decodeEntry(canonicalJson({ ...bind, kind: "review", entry: ulid("Q"), data: { verdict: "changes-requested", reviewedHead: commit("a"), digest: "digest", summary: "requested", evidence: [] } })), /unknown field 'reviewedHead'/);
});

test("strict canonical decoding rejects noncanonical journals and mismatched evidence identity", () => {
  assert.throws(() => decodeEntry(JSON.stringify(bind)), NonCanonicalEntryError);
  assert.throws(() => decodeJournal(encodeEntry(bind).replace(/\n$/, "")), /end with LF/);

  const checkId = ulid("J");
  assert.throws(() => decodeEntry(encodeEntry({
    v: 1,
    kind: "check",
    contract,
    entry: checkId,
    at,
    actor: "tester",
    data: { result: "pass", summary: "checked", evidence: [evidence(ulid("K"), "check")] },
  })), /evidence entry must match/);
});

test("evidence paths are derived from identity and never stored", () => {
  const ref = evidence(ulid("N"), "review");
  assert.equal(contractJournalPath(contract), "contracts/facts-contract.jsonl");
  assert.equal(evidencePath(contract, ref), `contracts/facts-contract/evidence/${ref.entry}/0-review`);
  assert.equal(evidencePath({ contract, ref }), evidencePath(contract, ref));
  assert.equal(encodeEntry(bind).includes("path"), false);
});

test("contract identities require kei coordinates and carrier paths use their private payload", () => {
  const id = contractId("kei/path-contract");
  assert.equal(id, "kei/path-contract");
  assert.equal(contractJournalPath(id), "contracts/path-contract.jsonl");

  for (const invalid of ["path-contract", "kei/UPPER", "kei/with.dot", "kei/with_under", "kei/a/b", "kei/"]) {
    assert.throws(() => contractId(invalid), /contract ID must be kei/);
  }
});

test("forfeit note is optional and current payload has no final head", () => {
  const withNote = entry({ v: 1, kind: "forfeit", contract, entry: ulid("M"), at, actor: "tester", data: { reason: "manual", note: "done" } });
  const withoutNote = entry({ v: 1, kind: "forfeit", contract, entry: ulid("N"), at, actor: "tester", data: { reason: "bind-failed" } });
  assert.deepEqual(decodeEntry(encodeEntry(withNote)), withNote);
  assert.deepEqual(decodeEntry(encodeEntry(withoutNote)), withoutNote);
  assert.throws(() => decodeEntry(canonicalJson({ ...withNote, data: { reason: "manual", finalHead: commit("a") } })), FactsCodecError);
});

test("fold requires bind and keeps the exact flat state shape", () => {
  assert.throws(() => foldJournal(contract, []), /journal must begin with bind/);
  assert.throws(() => foldJournal(contract, [entry({ v: 1, kind: "amend", contract, entry: ulid("P"), at, actor: "tester", data: { region: ["src"] } })]), /journal must begin with bind/);

  const state = foldJournal(contract, claimedJournal().slice(0, 2), contractHead("1".repeat(40)));
  assert.equal(state.head, contractHead("1".repeat(40)));
  assert.equal(state.approval, null);
  assert.equal(effectiveBody(state).objective, "Objective\n\nSecond objective");
  assert.deepEqual(Object.keys(state).sort(), ["approval", "body", "delivery", "evidence", "head", "id", "petition", "phase", "terminal"]);
});

test("open initializes delivery, seal requires it, and renew preserves its target", () => {
  assert.throws(() => foldJournal(contract, [bind, seal("P")]), /seal requires an open delivery/);

  const opened = foldJournal(contract, [
    bind,
    open("Q"),
  ]);
  assert.equal(opened.approval, null);
  assert.deepEqual(opened.delivery, { target: "refs/heads/main", base: commit("a"), head: commit("a") });

  const renewed = foldJournal(contract, [
    bind,
    open("Q"),
    seal("R"),
    entry({ v: 1, kind: "renew", contract, entry: ulid("S"), at, actor: "tester", data: { newBase: commit("b"), oldHead: commit("a"), newHead: commit("c") } }),
  ]);
  assert.equal(renewed.phase, "active");
  assert.equal(renewed.approval, null);
  assert.deepEqual(renewed.delivery, { target: "refs/heads/main", base: commit("b"), head: commit("c") });

  const petitioned = foldJournal(contract, [bind, open("T"), seal("V"), claimPetition("W")]);
  assert.equal(petitioned.phase, "awaiting-verdict");
  assert.equal(petitioned.approval, null);
  assert.equal(petitioned.petition?.entry, ulid("W"));
});

test("renew requires the current delivery endpoint and refuses stale chains", () => {
  const opened = open("R");
  const first = entry({ v: 1, kind: "renew", contract, entry: ulid("S"), at, actor: "tester", data: { newBase: commit("b"), oldHead: commit("a"), newHead: commit("c") } });
  const stale = entry({ v: 1, kind: "renew", contract, entry: ulid("W"), at, actor: "tester", data: { newBase: commit("d"), oldHead: commit("a"), newHead: commit("e") } });
  const second = entry({ v: 1, kind: "renew", contract, entry: ulid("X"), at, actor: "tester", data: { newBase: commit("d"), oldHead: commit("c"), newHead: commit("e") } });
  const prefix = [bind, opened, seal("V"), first];
  assert.throws(() => foldJournal(contract, [...prefix, seal("Y"), stale]), /does not match current delivery head/);
  const state = foldJournal(contract, [...prefix, seal("Z"), second]);
  assert.deepEqual(state.delivery, { target: "refs/heads/main", base: commit("d"), head: commit("e") });
});

test("fold keeps approval as current evidence while awaiting a verdict and returns changes to active", () => {
  const petition = claimPetition("0");
  const awaiting = foldJournal(contract, [bind, open("A"), seal("B"), petition]);
  const approval = review("C");
  const approved = foldEntry(awaiting, approval);
  assert.equal(approved.phase, "awaiting-verdict");
  assert.equal(approved.petition?.entry, petition.entry);
  assert.equal(approved.approval, approval);
  assert.equal(approved.evidence[0]?.kind, "review");
  assert.deepEqual(approved.evidence[0], approval);
  const amended = foldEntry(approved, entry({ v: 1, kind: "amend", contract, entry: ulid("D"), at, actor: "tester", data: { region: ["src/changed"] } }));
  assert.equal(amended.approval, null);
  const requested = foldJournal(contract, [bind, open("D"), seal("E"), claimPetition("F"), review("G", "changes-requested")]);
  assert.equal(requested.phase, "active");
  assert.equal(requested.approval, null);
  assert.equal(requested.petition, null);
});

test("fold enforces current matching approval for claim, terminal immutability, and local ULID uniqueness", () => {
  const petition = claimPetition("H");
  const awaiting = [bind, open("J"), seal("K"), petition];
  const claim = entry({ v: 1, kind: "claim", contract, entry: ulid("M"), at, actor: "tester", data: { petition: petition.entry } });
  assert.throws(() => foldJournal(contract, [...awaiting, claim]), /requires an approval/);
  const mismatchedApproval = entry({
    v: 1,
    kind: "review",
    contract,
    entry: ulid("N"),
    at,
    actor: "reviewer",
    data: { verdict: "approved", reviewedHead: commit("d"), digest: "sha256:review", summary: "reviewed", evidence: [] },
  });
  assert.throws(() => foldJournal(contract, [...awaiting, mismatchedApproval, claim]), /approval for the petition delivery head/);

  const history = claimedJournal();
  const claimed = foldJournal(contract, history);
  assert.equal(claimed.phase, "claimed");
  assert.equal(claimed.approval, null);
  assert.equal(claimed.terminal?.kind, "claim");
  assert.throws(() => foldJournal(contract, [...history, entry({ v: 1, kind: "amend", contract, entry: ulid("1"), at, actor: "tester", data: { region: ["other"] } })]), /duplicate entry/);
  assert.throws(() => foldJournal(contract, [...history, entry({ v: 1, kind: "amend", contract, entry: ulid("Y"), at, actor: "tester", data: { region: ["other"] } })]), /claimed cannot accept amend/);

  const checked = foldJournal(contract, [...history, entry({ v: 1, kind: "check", contract, entry: ulid("C"), at, actor: "tester", data: { result: "pass", summary: "terminal check", evidence: [] } })]);
  const verified = foldJournal(contract, [...history, entry({ v: 1, kind: "verification", contract, entry: ulid("D"), at, actor: "tester", data: { result: "pass", summary: "terminal verification", evidence: [] } })]);
  assert.equal(checked.phase, "claimed");
  assert.equal(verified.phase, "claimed");
  assert.equal(checked.evidence.at(-1)?.kind, "check");
  assert.equal(verified.evidence.at(-1)?.kind, "verification");
});

test("forfeit is legal from every nonterminal phase and clears current pointers", () => {
  assert.equal(foldJournal(contract, [bind, entry({ v: 1, kind: "forfeit", contract, entry: ulid("4"), at, actor: "tester", data: { reason: "bind-failed" } })]).phase, "forfeited");
  assert.equal(foldJournal(contract, [bind, open("5"), seal("6"), entry({ v: 1, kind: "forfeit", contract, entry: ulid("7"), at, actor: "tester", data: { reason: "manual" } })]).phase, "forfeited");
  const petition = claimPetition("8");
  const awaiting = foldJournal(contract, [bind, open("9"), seal("A"), petition]);
  assert.equal(foldEntry(awaiting, entry({ v: 1, kind: "forfeit", contract, entry: ulid("B"), at, actor: "tester", data: { reason: "manual" } })).phase, "forfeited");
  const reviewed = foldEntry(awaiting, review("C"));
  const forfeited = foldEntry(reviewed, entry({ v: 1, kind: "forfeit", contract, entry: ulid("D"), at, actor: "tester", data: { reason: "manual" } }));
  assert.equal(forfeited.phase, "forfeited");
  assert.equal(forfeited.approval, null);
  assert.equal(forfeited.petition, null);
});
