import assert from "node:assert/strict";
import test from "node:test";
import { decodeJournal, encodeEntry } from "../src/core/facts/codec.js";
import {
  contractId,
  documentKey,
  documentSegmentKey,
  entryUlid,
  gate,
  requirementId,
  snapshotId,
  type JournalEntry,
} from "../src/core/facts/types.js";

test("the journal codec accepts only the opaque current format", () => {
  const bind: JournalEntry = {
    v: 1,
    kind: "bind",
    contract: contractId("kei/current-cut"),
    entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    at: "2026-08-06T00:00:00Z",
    data: {
      coordinates: { start: snapshotId("snapshot-initial"), workspace: "worktree" },
      terms: {
        document: { bytes: "# Current\n", key: documentKey("document-current") },
        segments: [documentSegmentKey("segment-current")],
        gates: [gate("edge-owned")],
        requirements: { "edge-owned": [requirementId("gate:edge-owned")] },
        after: [],
      },
    },
  };
  assert.deepEqual(decodeJournal(encodeEntry(bind)), [bind]);
  assert.throws(() => decodeJournal(encodeEntry(bind).replace('"v":1', '"v":0')), /entry\.v: expected version 1/);
  assert.throws(
    () => decodeJournal(encodeEntry(bind).replace('"kind":"bind"', '"kind":"open"')),
    /unknown journal entry kind: open/,
  );
});
