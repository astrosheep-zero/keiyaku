import assert from "node:assert/strict";
import test from "node:test";
import { contractId, changeId, gate, requirementId, snapshotId } from "../src/core/facts/types.js";
import { KeiyakuError } from "../src/index.js";
import { classifyVerb, type VerbOutput } from "../src/library/keiyaku-verbs.js";
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


test("normal and exceptional Contract receipts retain the same optional diagnostic evidence", () => {
  const diagnostic = Object.freeze({
    kind: "diagnostic" as const, severity: "optional" as const,
    path: "/tmp/check-scene", diagnostic: "removal failed", requirement: "check-a",
  });
  const candidate = snapshotId("a".repeat(40));
  const integration = snapshotId("b".repeat(40));
  const contentId = changeId("c".repeat(40));
  const delivery = Object.freeze({
    kind: "accepted" as const, contractId: id, candidate, integration, contentId,
    issues: Object.freeze([diagnostic]),
  });
  const ordinary = renderVerb("deliver", { contract: id }, { kind: "returned", value: delivery }, context);
  const preview = renderVerb("deliver", { contract: id, dryRun: true }, {
    kind: "returned", value: { kind: "ready", contractId: id, candidate, integration, contentId, scope: {}, issues: [diagnostic] },
  }, context);
  const terminal = renderVerb("abandon", { contract: id }, {
    kind: "returned", value: { kind: "accepted", contractId: id, issues: [diagnostic] },
  }, context);
  const failure = new KeiyakuError("aborted", "cancelled after delivery", {
    cause: new Error("native cancellation"),
    outcome: {
      kind: "contract", contractId: id, issues: [diagnostic],
      admitted: [{ kind: "deliver", candidate, integration, contentId }],
    },
  });
  const completion = { kind: "threw" as const, error: failure };
  const exceptional = renderVerb("deliver", { contract: id }, completion, context);
  const evidence = "  issue  diagnostic\n  path  /tmp/check-scene\n  requirement  check-a\n  diagnostic\n  removal failed";
  for (const text of [ordinary, preview, terminal, exceptional]) assert.ok(text.includes(evidence), text);
  assert.equal(ordinary.split("\n")[0], `deliver accepted  ${id}`);
  assert.equal(preview.split("\n")[0], `deliver --dry-run accepted  ${id}`);
  assert.equal(exceptional.split("\n")[0], `deliver ${classifyVerb("deliver", { contract: id }, completion)}  ${id}`);
  assert.ok(exceptional.includes(`  admitted  deliver\n  candidate  ${candidate}`));
  assert.ok(exceptional.includes("native cancellation"));
});

test("reconciliation and exceptional receipts share ordered repeated native movement", () => {
  const effect = Object.freeze({ kind: "ref" as const, name: "refs/heads/main", before: "a".repeat(40), after: "b".repeat(40) });
  const reconciliation = renderVerb("reconcile", { contract: id }, {
    kind: "returned", value: { kind: "contract", contractId: id, effects: [effect, effect] },
  }, { columns: 15, color: false });
  const failed = renderVerb("reconcile", { contract: id }, {
    kind: "threw", error: new KeiyakuError("internal", "after movement", {
      outcome: { kind: "contract", contractId: id, effects: [effect, effect] },
    }),
  }, { columns: 15, color: false });
  const rows = ["  effect  ref", "  reference  refs/heads/main", `  before  ${effect.before}`, `  after  ${effect.after}`];
  assert.deepEqual(reconciliation.split("\n").slice(1), [...rows, ...rows]);
  assert.deepEqual(failed.split("\n").slice(-8), [...rows, ...rows]);
});

test("failed delivery keeps independent admitted work, placed movement and dependent stop", () => {
  const value: VerbOutput<"deliver"> = {
    kind: "accepted", contractId: id,
    candidate: snapshotId("a".repeat(40)), integration: snapshotId("b".repeat(40)), contentId: changeId("c".repeat(40)),
    placement: { kind: "placed", target: "refs/heads/main", predecessor: snapshotId("d".repeat(40)) },
    continuation: { stopped: [{ contractId: contractId("kei/dependent"), stop: { kind: "failed", diagnostic: "dependent Git failed" } }] },
    issues: [{ kind: "target-checkout-retained", severity: "required", path: "/tmp/target", target: "refs/heads/main", diagnostic: "checkout cannot follow" }],
  };
  const text = renderVerb("deliver", { contract: id }, { kind: "returned", value }, context);
  assert.equal(text.split("\n")[0], `deliver failed  ${id}`);
  assert.ok(text.includes("  admitted  deliver"));
  assert.ok(text.includes(`  destination  refs/heads/main\n  before  ${"d".repeat(40)}\n  after  ${"b".repeat(40)}\n  placement  placed`));
  assert.match(text, /dependent  kei\/dependent\n  reason  failed\n  diagnostic\n  dependent Git failed/u);
  assert.ok(text.includes("checkout cannot follow"));
  assert.equal(JSON.parse(JSON.stringify(value)).placement.kind, "placed");
});
