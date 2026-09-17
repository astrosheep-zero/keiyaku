import assert from "node:assert/strict";
import test from "node:test";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  contractId,
  documentKey,
  entryUlid, snapshotId, type JournalEntry
} from "../src/core/facts/types.js";

const id = contractId("kei/fold-history");
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

function entry<K extends JournalEntry["kind"]>(
  kind: K,
  data: Extract<JournalEntry, { kind: K }>["data"],
  index: number,
): Extract<JournalEntry, { kind: K }> {
  return {
    v: 1,
    kind,
    contract: id,
    entry: uniqueEntryUlid(index),
    at: "2026-08-07T00:00:00Z",
    data,
  } as Extract<JournalEntry, { kind: K }>;
}

test("reintegrated codec rejects malformed data and fold rejects out-of-order entries", () => {
  const valid = entry(
    "reintegrated",
    {
      predecessor: snapshotId("target"),
      snapshot: snapshotId("candidate"),
    },
    3,
  );
  const malformed = encodeEntry(valid).replace('"snapshot":"candidate"', '"snapshot":""');
  assert.throws(() => decodeJournal(malformed), /data\.reintegrated\.snapshot/);

  const bind = entry(
    "bind",
    {
      coordinates: { start: snapshotId("initial"), workspace: "worktree" },
      terms: {
        document: { bytes: "# Initial\n", key: documentKey("initial") },
        segments: [],
        gates: [],
        after: [],
      },
    },
    0,
  );
  assert.throws(() => foldJournal(id, [bind, valid]), /reintegrated requires a deliver/);
});
