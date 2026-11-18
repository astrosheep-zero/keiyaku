import assert from "node:assert/strict";
import test from "node:test";
import { contractId, gate, requirementId, snapshotId } from "../src/core/facts/types.js";
import { dependencyKeySet } from "../src/core/subject.js";
import { renderContractHistory } from "../src/cli/render/contract-history.js";
import { contractWaitMemberText } from "../src/cli/render/contract-wait.js";
import { renderVerb } from "../src/cli/render/verbs.js";

const id = contractId("kei/compact-cli");
const context = { columns: 120, color: false };

test("show renders the native guidance object and keeps missing distinct", () => {
  assert.equal(
    renderVerb(
      "show",
      { selector: id },
      { kind: "returned", value: { kind: "present", guidance: "# Exact terms\n\nbody\n" } },
      context,
    ),
    "# Exact terms\n\nbody\n",
  );
  const missing = renderVerb("show", { selector: id }, { kind: "returned", value: { kind: "missing" } }, context);
  assert.match(missing, /show refused/u);
  assert.match(missing, /contract missing/u);
  assert.ok(missing.includes(id));
});

test("Contract wait renders changed, present, unknown and missing without conflating them", () => {
  assert.equal(
    [
      { id, changed: true as const, terminal: "claimed" as const },
      { id: contractId("kei/present") },
      { id: contractId("kei/unknown"), presence: "unknown" as const },
      { id: contractId("kei/missing"), presence: "missing" as const },
    ].map(contractWaitMemberText).join(", "),
    "kei/compact-cli (changed, accepted), kei/present, kei/unknown (unobserved), kei/missing (missing)",
  );
});

test("semantic Contract history renders native identities without raw journal carriers", () => {
  const text = renderContractHistory({
    kind: "contract",
    contractId: id,
    events: [
      {
        kind: "bind",
        id: "1",
        at: "2026-11-09T13:00:00Z",
        start: snapshotId("a".repeat(40)),
        gates: [gate("reviewed")],
        after: [],
        document: "# Contract terms\n",
      },
      {
        kind: "attestation",
        id: "2",
        at: "2026-11-09T13:01:00Z",
        gate: gate("verified"),
        requirement: requirementId("check-build"),
        verdict: "unsatisfied",
        subject: dependencyKeySet([{ kind: "snapshot", value: snapshotId("b".repeat(40)) }]),
        summary: "actual failure",
      },
      {
        kind: "arc",
        id: "3",
        at: "2026-11-09T13:02:00Z",
        chapter: 2,
        title: "Recovery",
        body: "one\ntwo",
      },
    ],
  });
  assert.match(text, /history  kei\/compact-cli · 3 entries/u);
  assert.match(text, /bound to targetless/u);
  assert.match(text, /× verification check-build · subject snapshot bbbbbbb/u);
  assert.match(text, /arc Recovery · 2 lines/u);
});

test("subject display keeps terminal-safe parts and literal unknown representations", () => {
  const unknown = '[["future-kind","opaque identity"]]';
  const text = renderContractHistory({
    kind: "contract",
    contractId: id,
    events: [
      {
        kind: "attestation",
        id: "1",
        at: "2026-11-09T13:03:00Z",
        gate: gate("verified"),
        requirement: requirementId("check-build"),
        verdict: "satisfied",
        subject: '[["document","opaque\\u0001identity"]]',
      },
      {
        kind: "attestation",
        id: "2",
        at: "2026-11-09T13:04:00Z",
        gate: gate("verified"),
        requirement: requirementId("check-build"),
        verdict: "satisfied",
        subject: unknown,
      },
    ],
  });
  assert.match(
    text,
    /subject document opaque�identity/u,
    "a recorded identity is laid out as a terminal-safe labeled fact",
  );
  assert.ok(
    text.includes(`subject ${unknown}`),
    "an unknown subject kind stays literal evidence instead of gaining a guessed reading",
  );
});
