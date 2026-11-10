import assert from "node:assert/strict";
import test from "node:test";
import { contractId, entryUlid, gate, requirementId, snapshotId } from "../src/core/facts/types.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { contractWaitText } from "../src/cli/render/contract-wait.js";
import { renderVerb } from "../src/cli/render/verbs.js";

const id = contractId("kei/compact-cli");
const context = { columns: 120, color: false };

test("show renders the native guidance object and keeps missing distinct", () => {
  assert.equal(
    renderVerb(
      "show",
      { contract: id },
      { kind: "returned", value: { kind: "present", guidance: "# Exact terms\n\nbody\n" } },
      context,
    ),
    "# Exact terms\n\nbody\n",
  );
  const missing = renderVerb("show", { contract: id }, { kind: "returned", value: { kind: "missing" } }, context);
  assert.match(missing, /show refused/u);
  assert.match(missing, /contract missing/u);
  assert.ok(missing.includes(id));
});

test("Contract wait renders changed, present, unknown and missing without conflating them", () => {
  assert.equal(
    contractWaitText({
      kind: "contract",
      reason: "deadline",
      contracts: [
        { id, changed: true, terminal: "claimed" },
        { id: contractId("kei/present") },
        { id: contractId("kei/unknown"), presence: "unknown" },
        { id: contractId("kei/missing"), presence: "missing" },
      ],
    }),
    "deadline: kei/compact-cli (changed, accepted), kei/present, kei/unknown (unobserved), kei/missing (missing)",
  );
});

test("semantic Contract history renders native identities without raw journal carriers", () => {
  const text = renderContractHistory({
    kind: "contract",
    contractId: id,
    events: [
      {
        kind: "bind",
        id: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        at: "2026-11-09T13:00:00Z",
        start: snapshotId("a".repeat(40)),
        gates: [gate("reviewed")],
      },
      {
        kind: "attestation",
        id: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
        at: "2026-11-09T13:01:00Z",
        gate: gate("verified"),
        requirement: requirementId("check-build"),
        verdict: "unsatisfied",
        subject: snapshotId("b".repeat(40)),
        summary: "actual failure",
      },
      {
        kind: "arc",
        id: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
        at: "2026-11-09T13:02:00Z",
        chapter: 2,
        title: "Recovery",
        body: "one\ntwo",
      },
    ],
  });
  assert.match(text, /history  kei\/compact-cli · bound · 3 entries/u);
  assert.match(text, /bound to targetless/u);
  assert.match(text, /× verification check-build · subject bbbbbbb/u);
  assert.match(text, /arc Recovery · 2 lines/u);
});
