import assert from "node:assert/strict";
import test from "node:test";
import { entryUlid, contractIdFromSegment, documentKey, snapshotId, type JournalEntry } from "../src/core/facts/types.js";
import { runBoundedAttempts } from "../src/protocol/run.js";

test("bounded admission classification stops on the first accepted or refused result", async () => {
  const seen: number[] = [];
  const accepted = await runBoundedAttempts<{ kind: "accepted"; value: number }, string>(
    [{ entryUlids: [] }, { entryUlids: [] }],
    async (_attempt, index) => {
      seen.push(index);
      return index === 0 ? { kind: "accepted", value: 7 } : { kind: "refused", refusal: "late" };
    },
  );
  assert.deepEqual(accepted, { kind: "accepted", value: 7 });
  assert.deepEqual(seen, [0]);

  const refused = await runBoundedAttempts<{ kind: "accepted"; value: number }, string>(
    [{ entryUlids: [] }, { entryUlids: [] }],
    async (_attempt, index) => {
      seen.push(index);
      return index === 0 ? { kind: "refused", refusal: "no" } : { kind: "accepted", value: 8 };
    },
  );
  assert.deepEqual(refused, { kind: "refused", refusal: "no" });
  assert.deepEqual(seen, [0, 0]);
});

test("stale and redecide spend contexts and exhaustion is distinct from a thrown callback", async () => {
  let calls = 0;
  const exhausted = await runBoundedAttempts<{ kind: "accepted"; value: number }, never>(
    [{ entryUlids: [] }, { entryUlids: [] }],
    async () => {
      calls += 1;
      return calls === 1 ? { kind: "stale" } : { kind: "redecide" };
    },
  );
  assert.deepEqual(exhausted, { kind: "exhausted" });
  assert.equal(calls, 2);

  await assert.rejects(
    () =>
      runBoundedAttempts<{ kind: "accepted"; value: number }, never>(
        [{ entryUlids: [] }, { entryUlids: [] }],
        async () => {
          calls += 1;
          throw new Error("attempt failed");
        },
      ),
    /attempt failed/u,
  );
  assert.equal(calls, 3, "an exception must not invoke a later attempt");
});

test("publication failure is terminal and never replays the spent callback", async () => {
  let calls = 0;
  const result = await runBoundedAttempts<{ kind: "accepted"; value: number }, never>(
    [{ entryUlids: [] }, { entryUlids: [] }],
    async () => {
      calls += 1;
      return { kind: "publication-failed", diagnostic: "busy" };
    },
  );
  assert.deepEqual(result, { kind: "publication-failed", diagnostic: "busy" });
  assert.equal(calls, 1);
});


test("empty budget is exhausted and only the final collision is terminal", async () => {
  let emptyCalls = 0;
  const empty = await runBoundedAttempts<{ kind: "accepted"; value: number }, never>([], async () => {
    emptyCalls += 1;
    return { kind: "accepted", value: 1 };
  });
  assert.deepEqual(empty, { kind: "exhausted" });
  assert.equal(emptyCalls, 0);

  const contract = contractIdFromSegment("classifier-collision");
  const entry = (value: string): JournalEntry => ({
    v: 1,
    kind: "bind",
    contract,
    entry: entryUlid(value),
    at: "2026-08-06T00:00:00Z",
    data: {
      coordinates: { start: snapshotId("start"), workspace: "worktree" },
      terms: { document: { bytes: "", key: documentKey("document") }, segments: [], gates: [], after: [] },
    },
  });
  const collision = {
    kind: "collision" as const,
    contractId: contract,
    planned: entry("01ARZ3NDEKTSV4RRFFQ69G5FA1"),
    observed: entry("01ARZ3NDEKTSV4RRFFQ69G5FA2"),
    plannedBytes: "planned",
    observedBytes: "observed",
  };
  const contexts = [
    { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA3")] },
    { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA4")] },
    { entryUlids: [entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FA5")] },
  ];
  const seen: string[] = [];
  const result = await runBoundedAttempts<{ kind: "accepted"; value: number }, never>(contexts, async (context, index) => {
    seen.push(context.entryUlids[0]!);
    return index === 1 ? { kind: "stale" } : collision;
  });
  assert.equal(result.kind, "collision");
  assert.deepEqual(seen, contexts.map((context) => context.entryUlids[0]));
});
