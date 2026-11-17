import assert from "node:assert/strict";
import test from "node:test";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import type { LiveStatusObservation } from "../src/akuma/akuma-observe.js";
import { type ActivityHistory, type ActivityRow, type OutcomeRow } from "../src/akuma/projection.js";
import {
  DEFAULT_CONTEXT,
  frameRule,
  historyText,
  killResultText,
  snapshotText,
  tellText,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import {
  askCurrentWorkLine,
  askResultText,
  renderCallText,
  renderForkText,
  renderKillText,
  renderAskText,
} from "../src/cli/render/akuma.js";
import { askRawAnswer } from "../src/cli/render/akuma-activity.js";
import { akumaMark } from "../src/cli/render/marks.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import type { AkumaObservation, AkumaTellResult, AkumaWaitItem } from "../src/akuma/selection-observation.js";
import { projectCurrentWork } from "../src/akuma/status-projection.js";
import type { DispatchAssociation } from "../src/index.js";
import type { ForkResult, SpawnResult } from "../src/library/akuma-creation.js";
import { contractId } from "../src/core/facts/types.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import {
  answeredOutcome,
  completedTool,
  turnStarted,
  AKUMA_ACTIVITY_AT,
  reportedFileChange,
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
    work: projectCurrentWork(rows),
    ...(rows.length === 0 ? {} : { recent: rows.slice(-3) }),
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

test("status retains execution context, current work, changes, and unavailable associations", () => {
  const id = "aku/worker/abcd1234";
  const note: ActivityRow = { kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "editing the projection" };
  const rows = [turnStarted(1), note];
  const status = statusOf(id, "running", rows, {
    cwd: "/work/appointed",
    changes: [reportedFileChange("/work/file")],
  });
  const lines = snapshotText(
    observation(status, { kind: "failed", diagnostic: "lookup refused" }),
    DEFAULT_CONTEXT,
  ).split("\n");
  assert.equal(lines[0], id, "identity roots the panel alone");
  assert.equal(lines[1], "  /work/appointed", "the execution directory is static context, not a labelled row");
  assert.equal(
    lines[2],
    frameRule([id, "  /work/appointed"], DEFAULT_CONTEXT.columns),
    "one rule divides context from activity",
  );
  assert.ok(lines[3]!.includes(note.text));
  assert.match(lines[4]!, /^● running$/u);
  assert.ok(lines.indexOf("  changes") > 4, "reported changes follow the conclusion, subordinate");
  assert.ok(lines.some((line) => /^ {4}~ +\/work\/file$/u.test(line)));
  assert.equal(
    lines.filter((line) => line.includes("/work/appointed")).length,
    1,
    "no static coordinate is repeated below the timeline",
  );
  assert.ok(lines.indexOf("  ! contract association unavailable") > lines.indexOf("  changes"));
  assert.deepEqual(lines.slice(-2), ["  ! contract association unavailable", "    lookup refused"]);
  assert.equal(lines.filter((line) => line.startsWith("!")).length, 0, "a diagnostic never becomes a bare static fact");
});

test("history retains input, speech, actions, outcomes, and omission evidence", () => {
  const events: ActivityRow[] = [
    { kind: "call", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "first input" },
    { kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "spoken line\n  indented line" },
    { kind: "thought", sequence: 3, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "hidden reasoning" },
    { kind: "note", sequence: 4, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "a note" },
    completedTool(5, "bash", { kind: "run", command: "echo ok" }),
    completedTool(6, "bash", { kind: "run", command: "false" }, { status: "error", exitCode: 1 }),
    {
      kind: "tell",
      sequence: 7,
      at: AKUMA_ACTIVITY_AT,
      tellId: "tell/grammar",
      text: "pending input",
      state: "pending",
      deliveries: [],
    },
    answeredOutcome(8, "the answer"),
  ];
  const text = historyText(
    {
      kind: "akuma",
      akumaId: parseAkumaId("aku/worker/abcd1234").id,
      events,
      omitted: 2,
      lowestRetainedSequence: 1,
      highestSequence: 8,
    },
    {},
    { columns: 72, color: false },
  );
  for (const evidence of [
    "first input", "spoken line", "indented line", "hidden reasoning", "a note", "echo ok", "exit 1",
    "pending input", "the answer", "2 earlier events",
  ])
    assert.ok(text.includes(evidence), evidence);
});

test("paged history exposes copyable report and Turn coordinates with indented payloads", () => {
  const events: ActivityHistory["rows"] = [
    { kind: "report", sequence: 123456789, bodySequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "progress\n  detail" },
    { ...answeredOutcome(10, "answer\n  nested"), turnSequence: 123456789 },
    { ...answeredOutcome(11, ""), turnSequence: 2 },
    { kind: "outcome", sequence: 12, turnSequence: 3, at: AKUMA_ACTIVITY_AT, outcome: { kind: "failed", diagnostic: "failed\n  cause" } },
    { kind: "outcome", sequence: 13, turnSequence: 4, at: AKUMA_ACTIVITY_AT, outcome: { kind: "canceled" } },
  ];
  const page = { kind: "akuma" as const, akumaId: SPECIMEN_ID, events };
  const wide = historyText(page, {}, { columns: 100, color: false });
  assert.ok(wide.includes("   report/123456789 progress\n"));
  assert.ok(wide.includes("✓ turn/123456789\n  answer\n    nested"));
  assert.ok(wide.includes("✓ turn/2\n! turn/3\n  failed\n    cause\n○ turn/4 · canceled"));
  const narrow = historyText(page, {}, { columns: 10, color: false });
  for (const coordinate of ["report/123456789", "turn/123456789", "turn/2", "turn/3", "turn/4"])
    assert.ok(narrow.includes(coordinate), coordinate);
});

test("history renders the full exact report without confusing it with an outcome", () => {
  const text = " report\n  complete\n";
  assert.equal(
    historyText(
      {
        kind: "akuma-report",
        akumaId: parseAkumaId("aku/elite/b9977141").id,
        sequence: 5, bodySequence: 1, turnSequence: 2, at: AKUMA_ACTIVITY_AT, text,
      },
      { id: "report/5" },
      { columns: 64, color: false },
    ),
    text,
  );
});

test("history keeps long call and Tell inputs to one bounded input line", () => {
  const text = "Final minimal correction ".repeat(12);
  const rows: ActivityHistory["rows"] = [
    { kind: "call", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text },
    {
      kind: "tell",
      sequence: 2,
      at: AKUMA_ACTIVITY_AT,
      tellId: "tell/long-input",
      text,
      state: "pending",
      deliveries: [],
    },
  ];
  const lines = historyText(
    {
      kind: "akuma",
      akumaId: parseAkumaId("aku/elite/b9977141").id,
      events: rows,
      lowestRetainedSequence: 1,
      highestSequence: 2,
    },
    {},
    { columns: 64, color: false },
  ).split("\n");
  assert.equal(lines.length, 4, "identity, rule, and exactly one line per input");
  assert.match(lines[2]!, /^▸ Final minimal correction .*…$/u);
  assert.match(lines[3]!, /^⧗ Final minimal correction .*…$/u);
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
  assert.deepEqual(observation(status).work.pending, [{ id: 1, tellId: "tell/pending" }]);
  assert.match(text, /⧗ pending tell$/u);
});

test("activity age writes a suffix only when the age names a unit", () => {
  const status = statusOf("aku/worker/abcd1234", "running", []);
  const observedAt = Date.parse(AKUMA_ACTIVITY_AT);
  const text = (lastActivityAt: string, now: number) =>
    snapshotText({ ...observation(status), lastActivityAt }, { ...DEFAULT_CONTEXT, now });
  assert.match(text(new Date(observedAt + 2_000).toISOString(), observedAt), /^ {2}running · last activity now$/mu);
  assert.match(text(AKUMA_ACTIVITY_AT, observedAt + 19_000), /^ {2}running · last activity 19s ago$/mu);
  assert.doesNotMatch(text(AKUMA_ACTIVITY_AT, observedAt + 19_000), /now/u);
});

test("Akuma observation failures name the target and reason without carrier words", () => {
  const first = parseAkumaId("aku/worker/abcd0102").id;
  const second = parseAkumaId("aku/intern/33dd4670").id;
  assert.equal(
    waitText(
      {
        kind: "akuma",
        reason: "deadline",
        results: [
          { kind: "unobserved", id: first, diagnostic: "heart locked" },
          { kind: "unobserved", id: second, diagnostic: "permission denied" },
        ],
      },
      {},
      DEFAULT_CONTEXT,
    ),
    [`! ${first} — observation failed · heart locked`, `! ${second} — observation failed · permission denied`].join(
      "\n",
    ),
  );
});

function waitItem(status: LiveStatusObservation["status"], rows: readonly ActivityRow[]): AkumaWaitItem {
  const pending = status.work.pending !== undefined;
  const outcome = status.work.kind === "idle"
    ? rows.findLast((row): row is OutcomeRow => row.kind === "outcome")
    : undefined;
  return {
    kind: "observed",
    id: status.id,
    life: status.life,
    ...(pending ? { pending: true } : {}),
    ...(outcome === undefined ? {} : { outcome: { ...outcome.outcome, historyId: `turn/${outcome.turnSequence}` as const } }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
  };
}

function singleWait(
  status: LiveStatusObservation["status"],
  rows: readonly ActivityRow[],
  columns = 120,
  alias?: string,
): string {
  return waitText(
    { kind: "akuma", reason: "completed", results: [waitItem(status, rows)] },
    { ...(alias === undefined ? {} : { alias }) },
    { columns, color: false },
  );
}

function failedOutcome(sequence: number, diagnostic: string): OutcomeRow {
  return {
    kind: "outcome",
    sequence,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "failed", diagnostic },
  };
}

function pendingTellRow(sequence: number): Extract<ActivityRow, { kind: "tell" }> {
  return {
    kind: "tell",
    sequence,
    at: AKUMA_ACTIVITY_AT,
    tellId: `tell/pending-${sequence}`,
    text: "still waiting",
    state: "pending",
    deliveries: [],
  };
}

test("wait renders compact member facts and complete labeled outcomes", () => {
  const members: Array<[LiveStatusObservation["status"], readonly ActivityRow[]]> = [
    [statusOf("aku/worker/abcd0103", "asleep", [failedOutcome(1, "provider 503")]), [failedOutcome(1, "provider 503")]],
    [statusOf("aku/worker/abcd0105", "killed", [answeredOutcome(1, "stale answer")]), [answeredOutcome(1, "stale answer")]],
    [statusOf("aku/worker/abcd0106", "hung", [turnStarted(1)]), [turnStarted(1)]],
    [statusOf("aku/worker/abcd0107", "untidy", [turnStarted(1)]), [turnStarted(1)]],
    [statusOf("aku/worker/abcd0108", "stranded", [turnStarted(1)], { strandedReason: "resume-unsupported" }), [turnStarted(1)]],
    [statusOf("aku/worker/abcd0109", "asleep", [pendingTellRow(1)]), [pendingTellRow(1)]],
    [statusOf("aku/worker/abcd0110", "running", [turnStarted(1), pendingTellRow(1)]), [turnStarted(1), pendingTellRow(1)]],
  ];
  const text = waitText(
    { kind: "akuma", reason: "completed", results: members.map(([status, rows]) => waitItem(status, rows)) },
    {},
    { columns: 120, color: false },
  );
  assert.equal(
    text,
    [
      "! aku/worker/abcd0103 — failed",
      "  turn/1 · failed",
      "  provider 503",
      "× aku/worker/abcd0105 — killed",
      "  turn/1 · answered",
      "  stale answer",
      "? aku/worker/abcd0106 — hung",
      "! aku/worker/abcd0107 — untidy",
      "! aku/worker/abcd0108 — stranded · resume-unsupported",
      "⧗ aku/worker/abcd0109 — pending tell",
      "● aku/worker/abcd0110 — running · pending tell",
    ].join("\n"),
    "member order and stopped life stay explicit beside an exact-turn outcome",
  );
  assert.doesNotMatch(text, /\n\n/u, "no blank block separators");
  assert.doesNotMatch(text, /\d{2}:\d{2}/u, "no wall clocks");
  assert.doesNotMatch(text, /─|changes|debts/u, "no full status frame, change or Debt dump");
});

test("wait wraps its full answer without truncating identity or payload", () => {
  const id = "aku/worker/abcd0111";
  const rows = [answeredOutcome(1, "a very long answered preview that cannot fit")];
  const status = statusOf(id, "asleep", rows);
  const narrow = singleWait(status, rows, 40);
  assert.ok(narrow.startsWith(`✓ ${id} — `), "the mark, complete identity, and separator survive");
  assert.ok(narrow.endsWith("cannot fit"), "the answer tail remains complete at narrow width");
  const wide = singleWait(status, rows, 200);
  assert.equal(
    wide,
    `✓ ${id} — answered\n  turn/1 · answered\n  a very long answered preview that cannot fit`,
    "the exact turn labels the complete answer",
  );
});

test("wait keeps a single-target alias and none in plural output", () => {
  const status = statusOf("aku/worker/abcd0112", "asleep", []);
  assert.equal(singleWait(status, [], 120, "@scout"), "✓ aku/worker/abcd0112 (@scout) — completed");
  const other = statusOf("aku/worker/abcd0113", "asleep", []);
  const plural = waitText(
    {
      kind: "akuma",
      reason: "completed",
      results: [waitItem(status, []), waitItem(other, [])],
    },
    { alias: "@scout" },
    DEFAULT_CONTEXT,
  );
  assert.doesNotMatch(plural, /@scout/u, "an ambiguous alias is not attached to any member");
});

test("Tell admission and final Ask answer retain their distinct native facts", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const context = { columns: 80, color: false };
  const answer = { akumaId: id, tellId: "tell-id", kind: "answered" as const, answer: "exact answer" };
  assert.equal(askRawAnswer(answer), JSON.stringify("exact answer"));
  const tell = { kind: "admitted" as const, akumaId: id, tellId: "tell-id" };
  const standalone = tellText(tell, "continue", undefined, context);
  assert.equal(standalone, "✓ told aku/worker/deadbeef — continue", "verdict, subject, and input on one line");
  assert.equal(renderAskText(answer, undefined, context), JSON.stringify("exact answer"));
  assert.equal(askResultText(answer, undefined, context), `✓ answered ${id}\n  input tell-id`);
  const longPrompt = "one line of caller input ".repeat(20);
  const receipt = tellText(tell, longPrompt, undefined, context).split("\n");
  assert.equal(receipt.length, 1, "one receipt line even past the terminal width");
  assert.match(receipt[0]!, /^✓ told aku\/worker\/deadbeef — one line of caller input .*…$/u);
  assert.doesNotMatch(
    receipt.join("\n"),
    /running|completed|pending tell|─|"$/u,
    "an action receipt has no frame and adds no quotes",
  );
  assert.match(
    tellText({ ...tell, wake: { kind: "pending" } }, longPrompt, undefined, context),
    /^⧗ tell aku\/worker\/deadbeef — one line of caller input .*…$/mu,
    "a pending Tell keeps neutral vocabulary and the pending mark",
  );
  assert.equal(
    tellText({ ...tell, kind: "failed", failures: [{ stage: "wake", diagnostic: "wake refused" }] }, "continue", undefined, context),
    ["! tell aku/worker/deadbeef — continue", "  ! tell delivery failed", "    wake refused"].join("\n"),
    "an admitted Tell stays admitted and its failed wake keeps its own diagnosis",
  );
  assert.equal(killResultText(id, "killed"), `✓ killed ${id}`);
  assert.equal(
    killResultText(id, "unavailable", "@tired"),
    `! not killed ${id} (@tired)\n  unavailable`,
    "an untidy outcome keeps its native evidence",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(answer)), answer);

  assert.equal(askRawAnswer({ ...answer, answer: "decoded scalar" }), '"decoded scalar"');
});

test("Ask line preserves complete identity and explicit life while bounding native work", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const context = { columns: 100, color: false };
  assert.equal(askCurrentWorkLine({ id }, 2_900, context), `${id} · observing 2s`);
  assert.equal(
    askCurrentWorkLine({ id, life: "asleep" }, 4_000, context),
    `${id} · last observed asleep · observing 4s`,
  );
  const narrow = askCurrentWorkLine(
    { id, alias: "@scout", life: "running", summary: { id: 5, text: "run a long command", clipped: true } },
    6_000,
    { columns: 20, color: false },
  );
  assert.equal(narrow, `${id} (@scout) · last observed running · … · observing 6s`);
});

test("final Ask facts preserve exact native outcomes and historical wake failure", () => {
  const subject = { akumaId: SPECIMEN_ID, tellId: "tell/answer" };
  const context = { columns: 100, color: false };
  const answered = {
    ...subject,
    kind: "answered" as const,
    answer: { ok: true },
    wake: { kind: "failed" as const, diagnostic: "launch refused", logPath: "/work/wake.log" },
  };
  const final = renderAskText(answered, "@worker", context);
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
    assert.match(askResultText(result, undefined, context), new RegExp(kind, "u"));
    assert.equal(askRawAnswer(result), undefined);
  }
  const invalid = { ...subject, kind: "invalid-output" as const, diagnostic: "not JSON", answer: "broken\n  evidence" };
  assert.equal(askRawAnswer(invalid), undefined);
  assert.match(
    askResultText(invalid, undefined, context),
    /invalid-output[\s\S]*not JSON[\s\S]*invalid answer[\s\S]*broken\n    evidence/u,
  );
});

test("Akuma presentation uses the settled six-mark vocabulary", () => {
  assert.equal(akumaMark("killed"), "×");
  assert.equal(akumaMark("running"), "●");
  assert.equal(akumaMark("asleep"), "○");
  assert.equal(akumaMark("stranded"), "!");
});

test("Akuma life mark covers the full life vocabulary from one definition site", () => {
  const expected = {
    running: "●",
    asleep: "○",
    unborn: "○",
    stranded: "!",
    untidy: "!",
    stillborn: "!",
    killed: "×",
    hung: "?",
  } as const;
  for (const life of Object.keys(expected) as Array<keyof typeof expected>) {
    assert.equal(akumaMark(life), expected[life], life);
  }
});

test("changes section renders unknown diffstat as ~ and known as +a -r", () => {
  const status = statusOf("aku/worker/abcd1234", "running", [turnStarted(1)], {
    changes: [
      reportedFileChange("/work/unknown"),
      { ...reportedFileChange("/work/known"), diffstat: { added: 3, removed: 1 } },
    ],
  });
  const text = snapshotText(observation(status), DEFAULT_CONTEXT);
  assert.ok(
    text.split("\n").some((line) => /^ {4}~ +\/work\/unknown$/u.test(line)),
    text,
  );
  assert.ok(
    text.split("\n").some((line) => /^ {4}\+3 -1 +\/work\/known$/u.test(line)),
    text,
  );
  assert.doesNotMatch(text, /\+\? -\?/u);
});

test("tool rows render unknown diffstat as ~ and known as +a -r", () => {
  const events = [
    completedTool(1, "edit", { kind: "fileChange", changes: [{ op: "add", path: "src/unknown.ts" }] }),
    completedTool(2, "edit", {
      kind: "fileChange",
      changes: [{ op: "update", path: "src/known.ts", diffstat: { added: 2, removed: 1 } }],
    }),
  ];
  const lines = historyText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id, events }, {}, { columns: 120, color: false });
  assert.match(lines, /src\/unknown\.ts — ~/u);
  assert.match(lines, /src\/known\.ts — \+2 -1/u);
  assert.doesNotMatch(lines, /\+\? -\?/u);
});

/**
 * The family specimens below are the readable contract of the hierarchy: an action receipt leads
 * with its verdict and subject, an observation panel separates identity, static context, activity,
 * conclusion, dynamic outputs, and diagnostics.
 */
const SPECIMEN_ID = parseAkumaId("aku/worker/1234abcd").id;

function compactTell(extra: Omit<Extract<AkumaTellResult, { kind: "admitted" }>, "kind" | "akumaId" | "tellId"> | Omit<Extract<AkumaTellResult, { kind: "failed" }>, "akumaId" | "tellId"> = {}): AkumaTellResult {
  return { kind: "admitted", akumaId: SPECIMEN_ID, tellId: "tell/specimen", ...extra };
}

function spawned(extra: Omit<Extract<SpawnResult, { kind: "spawned" }>, "kind" | "akumaId"> | Omit<Extract<SpawnResult, { kind: "failed" }>, "akumaId"> = {}): SpawnResult {
  return { kind: "spawned", akumaId: SPECIMEN_ID, ...extra };
}

function forkReceipt(
  parent: string,
  child: string,
  extra: Partial<Extract<ForkResult, { kind: "forked" }>> = {},
): ForkResult {
  return { kind: "forked", parentAkumaId: parseAkumaId(parent).id, childAkumaId: parseAkumaId(child).id, ...extra };
}

test("Akuma outcomes distinguish admission from failed execution", () => {
  const spawn = { akumaName: "worker" };
  const input = { akuma: SPECIMEN_ID, prompt: "go", schema: {} };
  assert.equal(classifyVerb("spawn", spawn, { kind: "returned", value: spawned() }), "accepted");
  assert.equal(classifyVerb("tell", input, { kind: "returned", value: compactTell() }), "accepted");
  assert.equal(
    classifyVerb("tell", input, {
      kind: "returned",
      value: compactTell({ kind: "failed", failures: [{ stage: "wake", diagnostic: "wake refused" }] }),
    }),
    "failed",
  );
  assert.equal(
    classifyVerb("spawn", spawn, {
      kind: "returned",
      value: spawned({
        kind: "failed", failures: [{ stage: "birth", kind: "infrastructure", diagnostic: "provider stopped" }],
      }),
    }),
    "failed",
  );
  assert.equal(
    classifyVerb("ask", input, {
      kind: "returned",
      value: { akumaId: SPECIMEN_ID, tellId: "tell/specimen", kind: "failed", diagnostic: "provider stopped" },
    }),
    "failed",
  );
  assert.equal(
    classifyVerb("ask", input, {
      kind: "returned",
      value: { akumaId: SPECIMEN_ID, tellId: "tell/specimen", kind: "invalid-output", diagnostic: "schema mismatch", answer: "wrong" },
    }),
    "failed",
  );
});

test("shared ask rendering serializes JSON answers and retains non-answer conclusions", () => {
  const input = { akuma: SPECIMEN_ID, prompt: "go", schema: {} };
  const context = { columns: 100, color: false };
  const render = (observation: import("../src/index.js").AkumaAskObservation) =>
    renderVerb(
      "ask",
      input,
      { kind: "returned", value: { akumaId: SPECIMEN_ID, tellId: "tell/specimen", ...observation } },
      context,
    );
  assert.equal(render({ kind: "answered", answer: "exact\nanswer" }), JSON.stringify("exact\nanswer"));
  assert.match(render({ kind: "failed", diagnostic: "provider stopped" }), /provider stopped/u);
  assert.match(render({ kind: "invalid-output", diagnostic: "schema mismatch", answer: "wrong" }), /schema mismatch/u);
  const deadline = render({ kind: "deadline" });
  assert.match(deadline, /deadline/u);
  assert.doesNotMatch(deadline, /waited|NaN/u);
  assert.equal(render({ kind: "deadline" }), deadline);
});

test("every action receipt leads with a verdict and subject, then indented evidence", () => {
  const context = { columns: 100, color: false };
  assert.deepEqual(
    renderCallText(spawned(), context, { cwd: "/work/repo" }).split("\n"),
    ["✓ spawned aku/worker/1234abcd", "  /work/repo"],
    "a prompt-free birth is an action receipt with its invocation directory subordinate",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ alias: { kind: "moved", previousAkumaId: parseAkumaId("aku/worker/9999beef").id } }),
      context,
      { cwd: "/work/repo", contractId: contractId("kei/example-1234"), alias: "@reviewer" },
    ).split("\n"),
    [
      "✓ spawned aku/worker/1234abcd (@reviewer)",
      "  kei/example-1234",
      "  /work/repo",
      "  alias moved · previous aku/worker/9999beef",
    ],
    "the alias supplements the subject while Contract and directory stay explicit invocation context",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ kind: "failed", failures: [{ stage: "dispatch", failure: { kind: "infrastructure", diagnostic: "busy" } }] }),
      context,
      { cwd: "/work/repo" },
    ).split("\n"),
    ["! spawned aku/worker/1234abcd", "  /work/repo", "  ! dispatch failed infrastructure busy"],
    "a failed dispatch stage marks the receipt instead of standing under an unqualified success",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ kind: "failed", failures: [{ stage: "birth", kind: "infrastructure", diagnostic: "window lost" }] }),
      context,
      { cwd: "/work/repo" },
    ).split("\n"),
    ["! spawned aku/worker/1234abcd", "  /work/repo", "  ! birth failed infrastructure window lost"],
    "a detached failure without an admitted Tell stays an action receipt over the born child",
  );
  assert.deepEqual(
    renderCallText(
      spawned({
        tellId: "tell/specimen",
        kind: "failed", failures: [{ stage: "tell", kind: "infrastructure", diagnostic: "window lost", attemptedTellId: "tell/attempted" }],
      }),
      context,
      { cwd: "/work/repo", prompt: "exact prompt" },
    ).split("\n"),
    [
      "! spawned aku/worker/1234abcd",
      "  /work/repo",
      "  input tell/specimen",
      '  "exact prompt"',
      "  ! tell failed infrastructure window lost",
      "  attempted input tell/attempted",
    ],
    "an attempted Tell coordinate survives beneath the failed spawn verdict",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ dispatchWarning: "private-state-seat-close-failed seat closed late" }),
      context,
      { contractId: contractId("kei/example-1234"), cwd: "/work/repo" },
    ).split("\n"),
    [
      "✓ spawned aku/worker/1234abcd",
      "  kei/example-1234",
      "  /work/repo",
      "  dispatch lag private-state-seat-close-failed seat closed late",
    ],
    "an admitted lag is one joined diagnostic, not a failed verdict",
  );
  assert.deepEqual(
    renderForkText(forkReceipt("aku/worker/9999beef", "aku/worker/5678abcd"), {
      akuma: "aku/worker/9999beef",
      at: "turn/1",
    }).split("\n"),
    ["✓ forked aku/worker/5678abcd", "  from aku/worker/9999beef"],
    "a fork states its source without inventing a Turn or a directory",
  );
  assert.deepEqual(
    renderForkText(
      { kind: "failed", parentAkumaId: parseAkumaId("aku/worker/9999beef").id, childAkumaId: parseAkumaId("aku/worker/5678abcd").id,
        failure: { stage: "dispatch", failure: { kind: "publication-failed", diagnostic: "read-only mirror" } } },
      { akuma: "aku/worker/9999beef", at: "turn/1" },
    ).split("\n"),
    [
      "! forked aku/worker/5678abcd",
      "  from aku/worker/9999beef",
      "  ! dispatch failed publication-failed read-only mirror",
    ],
    "a forked child with a failed association keeps both identities and the concrete cause",
  );
  assert.deepEqual(
    renderForkText(
      { kind: "provider-cannot-fork", parentAkumaId: SPECIMEN_ID },
      { akuma: SPECIMEN_ID, at: "turn/1" },
    ).split("\n"),
    ["! fork aku/worker/1234abcd", "  provider cannot fork"],
    "a fork that never happened keeps its capability reason beneath the marked verdict",
  );
});

test("Tell and kill keep pending, failure, and plural evidence inside the action hierarchy", () => {
  const context = { columns: 100, color: false };
  assert.deepEqual(
    tellText(compactTell(), "go", undefined, context).split("\n"),
    ["✓ told aku/worker/1234abcd — go"],
    "the submitted payload appears once inline with its delivery verdict",
  );
  assert.equal(
    tellText(compactTell(), "  go  ", "@tired", context),
    "✓ told aku/worker/1234abcd (@tired) — go",
    "whitespace folds, the alias stays a parenthetical supplement, and no quote is added",
  );
  assert.equal(
    tellText(compactTell(), '  he said "wait"\n', undefined, context),
    '✓ told aku/worker/1234abcd — he said "wait"',
    "literal source quotes survive and folding invents no others",
  );
  assert.equal(
    tellText(compactTell(), "   ", undefined, context),
    "✓ told aku/worker/1234abcd",
    "an empty input adds no invented text or trailing separator",
  );
  const cramped = tellText(compactTell(), "go", undefined, {
    columns: 12,
    color: false,
  });
  assert.equal(
    cramped,
    "✓ told aku/worker/1234abcd — …",
    "a verdict and identity wider than the terminal stay whole and the input keeps its visible ellipsis",
  );
  assert.deepEqual(
    tellText(compactTell({ wake: { kind: "pending" } }), "go", undefined, context).split("\n"),
    ["⧗ tell aku/worker/1234abcd — go", "  wake pending"],
    "a pending Tell keeps the pending mark and asserts no delivery",
  );
  assert.deepEqual(
    tellText(compactTell({ kind: "failed", failures: [{ stage: "wake", diagnostic: "wake refused" }] }), "go", undefined, context).split("\n"),
    ["! tell aku/worker/1234abcd — go", "  ! tell delivery failed", "    wake refused"],
    "an admitted Tell stays admitted and its failed wake keeps its concrete cause",
  );
  assert.equal(
    renderKillText(
      {
        results: [
          { id: parseAkumaId("aku/worker/1234abcd").id, outcome: "killed" },
          { id: parseAkumaId("aku/worker/5678abcd").id, outcome: "already-stopped" },
          { id: parseAkumaId("aku/worker/9999beef").id, outcome: "hung" },
        ],
      },
      undefined,
      context,
    ),
    [
      "✓ killed aku/worker/1234abcd",
      "✓ already stopped aku/worker/5678abcd",
      "! not killed aku/worker/9999beef",
      "  hung",
    ].join("\n"),
    "plural kill keeps one compact block per member in frozen order",
  );
});

test("Tell delivery keeps copyable log coordinates on its subject and bounds the cause beneath", () => {
  const context = { columns: 40, color: false };
  const path = "/work/long-execution-directory/body.log";
  const lines = tellText(
    compactTell({
      kind: "failed", failures: [{ stage: "wake",
      diagnostic: `  wake\nrefused\t\u001b ${"👩‍💻".repeat(100)}`,
      logPath: path }],
    }),
    "go",
    undefined,
    context,
  ).split("\n");
  assert.equal(lines[1], `  ! tell delivery failed · log ${path}`);
  const payload = lines.slice(2);
  assert.equal(payload.length, 3, "the cause retains the shared bounded line budget");
  assert.match(payload[0]!, /^ {4}wake refused � 👩‍💻/u, "cause text is terminal-safe and whitespace-folded");
  assert.match(payload.at(-1)!, /…$/u, "the cause names its own omission");
  assert.match(payload.slice(1).join("\n"), /^(?: {4}(?:👩‍💻)+…?\n?)+$/u, "wrapping keeps whole graphemes");
});

test("an observation panel orders identity, context, activity, conclusion, outputs, and diagnostics", () => {
  const id = "aku/worker/abcd1234";
  const context = { columns: 100, color: false };
  const rows = [
    turnStarted(1),
    { kind: "said" as const, sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "edited" },
  ];
  const status = statusOf(id, "running", rows, {
    cwd: "/work/appointed",
    changes: [reportedFileChange("/work/file")],
  });
  const text = snapshotText(
    observation(
      status,
      { kind: "associated", contractId: contractId("kei/example-1234") },
    ),
    context,
  );
  const lines = text.split("\n");
  const head = [`${id} · kei/example-1234`, "  /work/appointed"];
  assert.deepEqual(lines.slice(0, 2), head, "identity carries its Contract inline and context sits beneath it");
  assert.equal(lines[2], frameRule(head, context.columns), "one rule divides context from content");
  assert.ok(lines[3]!.includes("edited"));
  assert.equal(lines[4], "● running", "the activity closes on one truthful conclusion");
  assert.deepEqual(
    lines.slice(5),
    ["  changes", "    ~  /work/file"],
    "dynamic outputs stay subordinate and no diagnostic is reported",
  );
  const failedReads = snapshotText(
    observation(
      status,
      { kind: "failed", diagnostic: "lookup refused" },
    ),
    context,
  );
  assert.deepEqual(
    failedReads.split("\n").slice(5),
    [
      "  changes",
      "    ~  /work/file",
      "  ! contract association unavailable",
      "    lookup refused",
    ],
    "failed reads name their observation subjects beneath outputs, with each cause in its own payload",
  );
});

test("a narrow panel never truncates a copyable identity", () => {
  const id = "aku/worker/abcd1234";
  const context = { columns: 40, color: false };
  const rows: ActivityRow[] = [
    turnStarted(1),
    { kind: "said", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "👩‍💻".repeat(30) },
  ];
  const status = statusOf(id, "running", rows, { cwd: "/work/界界界/deep/path" });
  const lines = snapshotText(
    observation(status, { kind: "associated", contractId: contractId("kei/narrow-columns") }),
    context,
  ).split("\n");
  assert.equal(lines[0], `${id} · kei/narrow-columns`, "the copyable identity is never wrapped or truncated");
  assert.ok(
    lines.some((line) => line.includes("👩‍💻")),
    "wide graphemes survive wrapping",
  );
});
