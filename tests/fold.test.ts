import assert from "node:assert/strict";
import test from "node:test";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import { foldJournal } from "../src/core/facts/fold.js";
import {
  contractId,
  documentKey,
  snapshotId, type JournalEntry
} from "../src/core/facts/types.js";
import { uniqueEntryUlid } from "./support/journal.js";

const id = contractId("kei/fold-history");

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
