import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decodeEntry, encodeEntry, UnknownEntryError } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import { verificationDeclarationKey } from "../src/core/facts/gate.js";
import { changeId, contractId, entryUlid, snapshotId, type ContractBody, type JournalEntry } from "../src/core/facts/types.js";
import { contractJournalPath } from "../src/carrier/identity.js";

const id = contractId("kei/current-cut");
const oid = snapshotId("a".repeat(40));
const candidate = snapshotId("b".repeat(40));
const body: ContractBody = { title: "Current", context: "context", objective: "objective", design: "design", region: ["src"], criteria: [{ title: "criterion", body: "criterion" }], verification: [{ executor: "bash", script: "true" }], gates: ["verified"], extensions: [] };

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.isFile() && /\.(?:[cm]?ts|js)$/.test(entry.name) ? [path] : [];
  });
}
function entry<K extends JournalEntry["kind"]>(kind: K, data: Extract<JournalEntry, { kind: K }> ["data"], suffix: string): Extract<JournalEntry, { kind: K }> {
  return { v: 1, kind, contract: id, entry: entryUlid(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`), at: "2026-08-05T00:00:00Z", actor: "tester", data } as Extract<JournalEntry, { kind: K }>;
}

test("current codec round trips and rejects deleted facts", () => {
  const bind = entry("bind", { coordinates: { start: oid, target: "refs/heads/main", workspace: "worktree" }, body }, "AV");
  assert.deepEqual(decodeEntry(encodeEntry(bind)), bind);
  assert.throws(() => decodeEntry('{"actor":"tester","at":"2026-08-05T00:00:00Z","contract":"kei/current-cut","data":{},"entry":"01ARZ3NDEKTSV4RRFFQ69G5FAW","kind":"seal","v":1}\n'), UnknownEntryError);
});

test("hard cut leaves no retired pact names in source, tests, or guards", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const removed = ["Commit" + "Oid", "Patch" + "Id", "ful" + "filled"];
  for (const directory of ["src", "tests", "scripts"]) {
    for (const path of sourceFiles(join(root, directory))) {
      const source = readFileSync(path, "utf8");
      for (const name of removed) assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`), `${path} retains ${name}`);
    }
  }
});

test("pact, protocol, and carrier carry no task association", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const directory of ["src/core", "src/protocol", "src/carrier"]) {
    for (const path of sourceFiles(join(root, directory))) {
      assert.doesNotMatch(readFileSync(path, "utf8"), /\btask\b/i, `${path} carries task association`);
    }
  }
});

test("pact cannot own carrier journal projection or layout", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (const path of sourceFiles(join(root, "src/core"))) {
    const source = readFileSync(path, "utf8");
    assert.doesNotMatch(source, /\bcontractJournalPath\b/, `${path} owns a carrier journal projection`);
    assert.doesNotMatch(source, /contracts\//, `${path} owns carrier journal layout`);
  }
});

test("carrier privately projects full contract identities into journal paths", () => {
  assert.equal(contractJournalPath(id), "contracts/current-cut.jsonl");
});

test("pact codecs preserve opaque tender identities and an omitted target", () => {
  const bind = entry("bind", {
    coordinates: { start: snapshotId("snapshot:initial"), workspace: "here" },
    body,
  }, "AW");
  const deliver = entry("deliver", {
    expectedPredecessor: snapshotId("snapshot:initial"),
    candidate: snapshotId("snapshot:current"),
    deliveryPatchId: changeId("change:content"),
  }, "AX");
  assert.deepEqual(decodeEntry(encodeEntry(bind)).data.coordinates.target, undefined);
  assert.deepEqual(decodeEntry(encodeEntry(deliver)).data, deliver.data);
});

test("actor testimony is optional but present testimony remains nonblank", () => {
  const actorless = {
    v: 1,
    kind: "bind",
    contract: id,
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
    at: "2026-08-05T00:00:00Z",
    data: { coordinates: { start: oid, workspace: "here" }, body },
  } satisfies JournalEntry;
  assert.deepEqual(decodeEntry(encodeEntry(actorless)), actorless);
  assert.throws(() => encodeEntry({ ...actorless, actor: " " }), /entry\.actor/);
});

test("current codec rejects the retired pipeline body field", () => {
  const bind = entry("bind", { coordinates: { start: oid, target: "refs/heads/main", workspace: "worktree" }, body }, "AV");
  const encoded = encodeEntry(bind).replace('"gates":["verified"]', '"pipeline":["verified"]');
  assert.throws(() => decodeEntry(encoded), /data\.bind\.body: unknown field 'pipeline'/);
  const malformed = encodeEntry(bind).replace('"gates":["verified"]', '"gates":["unknown"]');
  assert.throws(() => decodeEntry(malformed), /data\.bind\.body\.gates\[0\]: unknown gate/);
});

test("verified gate reads a matching verification fact", () => {
  const bind = entry("bind", { coordinates: { start: oid, target: "refs/heads/main", workspace: "worktree" }, body }, "AV");
  const bound = entry("bound", {}, "AW");
  const deliver = entry("deliver", { expectedPredecessor: oid, candidate, deliveryPatchId: changeId("c".repeat(40)) }, "AX");
  const verification = entry("verification", { candidate, declarationKey: verificationDeclarationKey(body.verification), result: "pass" }, "AY");
  const claimed = entry("claimed", { delivery: deliver.entry }, "AZ");
  assert.equal(foldJournal(id, [bind, bound, deliver, verification, claimed]).terminal?.kind, "claimed");
});

test("amend replaces the complete body and cannot change consumed prerequisites", () => {
  const dependency = contractId("kei/dependency");
  const original = { ...body, after: [dependency] };
  const bind = entry("bind", { coordinates: { start: oid, target: "refs/heads/main", workspace: "worktree" }, body: original }, "AV");
  const bound = entry("bound", {}, "AW");
  const amend = entry("amend", { ...body, after: [] }, "AX");
  assert.throws(() => foldJournal(id, [bind, bound, amend]), /prerequisites/);
});
