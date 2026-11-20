import assert from "node:assert/strict";
import test from "node:test";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import { AkumaKillError } from "../src/akuma/akuma-errors.js";
import type { LiveStatusObservation } from "../src/akuma/akuma-observe.js";
import type { ActivityRow } from "../src/akuma/projection.js";
import { compactTimelineItem } from "../src/akuma/timeline-text.js";
import {
  DEFAULT_CONTEXT,
  snapshotText,
  tellText,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import {
  askResultText,
  renderKillText,
  renderAskText,
} from "../src/cli/render/akuma.js";
import { askRawAnswer } from "../src/cli/render/akuma-activity.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import type { AkumaObservation, AkumaTellResult, AkumaWaitItem } from "../src/akuma/selection-observation.js";
import { summarizeFrontier } from "../src/akuma/status-projection.js";
import type { DispatchAssociation } from "../src/index.js";
import { contractId } from "../src/core/facts/types.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import {
  answeredOutcome,
  turnStarted,
  AKUMA_ACTIVITY_AT,
} from "./support/kanshi-activity.js";

const DIRECT_BIRTH = { origin: { kind: "direct" }, caller: { kind: "unknown" } } as const;

function statusOf(
  id: string,
  life: LiveStatusObservation["status"]["life"],
  rows: readonly ActivityRow[],
  extra: Readonly<Record<string, unknown>> = {},
): LiveStatusObservation["status"] {
  return liveStatusObservationSchema.unwrap().shape.status.parse({
    birth: DIRECT_BIRTH,
    id,
    life,
    work: summarizeFrontier(rows, "/work").work,
    ...extra,
  });
}

/** One native selected observation over a status row; absence stays absent. */
function observation(
  status: LiveStatusObservation["status"],
  association: DispatchAssociation = { kind: "none" },
): AkumaObservation {
  return {
    kind: "akuma",
    id: status.id,
    life: status.life,
    cwd: status.cwd ?? "/work/repo",
    provider: status.provider ?? "fixture",
    work: status.work,
    ...(status.recent === undefined ? {} : { recent: status.recent }),
    ...(status.model === undefined ? {} : { model: status.model }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
    ...(association.kind === "none" ? {} : { contract: association }),
    ...(status.changes === undefined ? {} : { changes: status.changes }),
    ...(status.moreChanges === undefined ? {} : { moreChanges: status.moreChanges }),
    ...(status.outsideChanges === undefined ? {} : { outsideChanges: status.outsideChanges }),
  };
}

test("paged history exposes copyable report and Turn coordinates with indented payloads", () => {
  const events: readonly ActivityRow[] = [
    { kind: "report", sequence: 123456789, bodySequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "progress\n  detail" },
    { ...answeredOutcome(10, "answer\n  nested"), turnSequence: 123456789 },
    { ...answeredOutcome(11, ""), turnSequence: 2 },
    { kind: "outcome", sequence: 12, turnSequence: 3, at: AKUMA_ACTIVITY_AT, outcome: { kind: "failed", diagnostic: "failed\n  cause" } },
    { kind: "outcome", sequence: 13, turnSequence: 4, at: AKUMA_ACTIVITY_AT, outcome: { kind: "canceled" } },
  ];
  const page = { kind: "akuma" as const, akumaId: SPECIMEN_ID, events: events.map(compactTimelineItem) };
  const value = { kind: "returned" as const, value: page };
  const query = { selector: SPECIMEN_ID };
  const narrow = renderVerb("history", query, value, { columns: 10, color: false });
  assert.equal(narrow, renderVerb("history", query, value, { columns: 120, color: false }));
  assert.ok(narrow.includes("  report/123456789\n  progress\n    detail"));
  assert.ok(narrow.includes("✓ turn/123456789\n  answer\n    nested"));
  assert.ok(narrow.includes("✓ turn/2\n! turn/3\n  failed\n    cause\n○ turn/4 · canceled"));
});

test("sleeping with a pending Tell concludes pending, not completed", () => {
  const pending: ActivityRow = {
    kind: "tell",
    sequence: 1,
    at: AKUMA_ACTIVITY_AT,
    tellId: "tell/pending",
    text: "follow up",
    state: "pending",
    deliveries: [],
  };
  const rows = [pending];
  const status = statusOf("aku/worker/abcd1234", "asleep", rows);
  const text = snapshotText(observation(status), DEFAULT_CONTEXT);
  assert.match(text, /pending input 1/u);
  assert.deepEqual(observation(status).work.pending, [{ id: 1 }]);
  assert.match(text, /⧗ pending tell$/u);
});

test("wait keeps a separately labeled older conclusion and its full exact answer", () => {
  const akuma = parseAkumaId("aku/worker/abcd0111").id;
  const answer = `${"👩‍💻".repeat(175)}\n  detail\nthird\nfourth\n`;
  const member: AkumaWaitItem = { akuma, state: "running", turn: "turn/2",
    last: { state: "done", turn: "turn/1", at: AKUMA_ACTIVITY_AT, answer } };
  const text = waitText({ kind: "akuma", reason: "deadline", results: [member] }, { alias: "@scout" });
  assert.match(text, /@scout[^\n]*running turn\/2\n  last done turn\/1/u);
  assert.equal(text.split("\n").slice(2).map(line => line.slice(4)).join("\n"), answer);
  const other = parseAkumaId("aku/worker/abcd0113").id;
  assert.doesNotMatch(waitText({ kind: "akuma", reason: "deadline", results: [member, { akuma: other, state: "idle" }] }, { alias: "@scout" }), /@scout/u);
});

test("final Ask facts preserve exact native outcomes and historical wake failure", () => {
  const subject = { akumaId: SPECIMEN_ID, tellId: "tell/answer" };
  const answered = {
    ...subject,
    kind: "answered" as const,
    answer: { ok: true },
    wake: { kind: "failed" as const, diagnostic: "launch refused", logPath: "/work/wake.log" },
  };
  const final = renderAskText(answered, "@worker");
  for (const fact of [
    "✓ answered",
    SPECIMEN_ID,
    "@worker",
    subject.tellId,
    "launch refused",
    "/work/wake.log",
    JSON.stringify(answered.answer),
  ])
    assert.ok(final.includes(fact), final);
  assert.equal(
    classifyVerb("ask", { akuma: SPECIMEN_ID, prompt: "go", schema: {} }, { kind: "returned", value: answered }),
    "accepted",
  );
  for (const kind of ["deadline", "unanswered"] as const) {
    const result = { ...subject, kind };
    assert.match(askResultText(result, undefined), new RegExp(kind, "u"));
    assert.equal(askRawAnswer(result), undefined);
  }
  const invalid = { ...subject, kind: "invalid-output" as const, diagnostic: "not JSON", answer: "broken\n  evidence" };
  assert.equal(askRawAnswer(invalid), undefined);
  assert.match(
    askResultText(invalid, undefined),
    /invalid-output[\s\S]*not JSON[\s\S]*invalid answer[\s\S]*broken\n    evidence/u,
  );
});

/**
 * The family specimens below are the readable contract of the hierarchy: an action receipt leads
 * with its verdict and subject, an observation panel separates identity, static context, activity,
 * conclusion, dynamic outputs, and diagnostics.
 */
const SPECIMEN_ID = parseAkumaId("aku/worker/1234abcd").id;

function compactTell(extra: { turn?: `turn/${number}` } | Omit<Extract<AkumaTellResult, { result: "failed" }>, "akumaId" | "tellId"> = {}): AkumaTellResult {
  const subject = { akumaId: SPECIMEN_ID, tellId: "tell/specimen" };
  return "result" in extra ? { ...subject, ...extra } : { ...subject, result: "told", ...extra };
}

test("Tell and kill keep exact control and plural evidence inside the action hierarchy", () => {
  const told = compactTell({ turn: "turn/17" });
  assert.equal(tellText(told, "go", "@fleet-desk"), "▸ @fleet-desk  told turn/17");
  const stoppedTell = compactTell({ result: "failed", interrupt: { kind: "completed" }, failures: [{ stage: "wake", diagnostic: "wake refused" }] });
  assert.match(tellText(stoppedTell, "go", undefined), /interrupt completed[\s\S]*wake refused/u);
  assert.equal(
    renderKillText(
      {
        results: [
          { id: parseAkumaId("aku/worker/1234abcd").id, outcome: "killed" },
          { id: parseAkumaId("aku/worker/5678abcd").id, outcome: "already-stopped" },
          { id: parseAkumaId("aku/worker/9999beef").id, outcome: "hung" },
        ],
      },
      undefined
    ),
    [
      "✓ killed aku/worker/1234abcd",
      "✓ already stopped aku/worker/5678abcd",
      "! not killed aku/worker/9999beef",
      "  hung",
    ].join("\n"),
    "plural kill keeps one compact block per member in frozen order",
  );
  const stopped = new AkumaKillError(new Error("observation canceled"), [
    { id: parseAkumaId("aku/worker/1234abcd").id, outcome: "killed" },
    { id: parseAkumaId("aku/worker/5678abcd").id, outcome: "stop-admitted" },
  ]);
  const context = { columns: 100, color: false };
  assert.equal(renderVerb("kill", { akuma: "aku/worker/*" }, { kind: "threw", error: stopped }, context), [
    "× kill failed",
    "✓ killed aku/worker/1234abcd",
    "! stop admitted aku/worker/5678abcd",
    "  reason observation canceled",
  ].join("\n"));
});

test("Tell delivery keeps typed log coordinates and the complete terminal-safe cause", () => {
  const path = `/work/${"long-execution-directory/".repeat(15)}body.log`;
  const detail = `${"👩‍💻".repeat(170)}\nrecovery: inspect the original worktree`;
  const lines = tellText(
    compactTell({
      result: "failed", failures: [{ stage: "wake",
      diagnostic: `  wake\nrefused\t\u001b ${detail}`,
      logPath: path }],
    }),
    "go",
    undefined
  ).split("\n");
  assert.equal(lines[1], `  ! tell delivery failed · log ${path}`);
  assert.equal(lines.slice(2).map((line) => line.slice(4)).join("\n"), `  wake\nrefused � ${detail}`);
});

test("a narrow panel never truncates a copyable identity", () => {
  const id = "aku/worker/abcd1234";
  const context = { columns: 40, color: false };
  const rows: ActivityRow[] = [
    turnStarted(1),
    { kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "👩‍💻".repeat(30) },
  ];
  const cwd = `/work/${"very-deep-directory/".repeat(12)}path`;
  const status = statusOf(id, "running", rows, { cwd });
  const view = observation(status, { kind: "associated", contractId: contractId("kei/narrow-columns") });
  const text = snapshotText(view, context);
  assert.equal(text, snapshotText(view, { ...context, columns: 120 }));
  assert.deepEqual(text.split("\n").slice(0, 2), [`${id} · kei/narrow-columns`, `  ${cwd}`]);
  assert.ok(text.includes("👩‍💻"), "whole graphemes survive preview rendering");
});
