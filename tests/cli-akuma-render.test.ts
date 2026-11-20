import assert from "node:assert/strict";
import test from "node:test";
import { liveStatusObservationSchema } from "../src/akuma/akuma-selection-execution.js";
import { AkumaKillError } from "../src/akuma/akuma-errors.js";
import type { LiveStatusObservation } from "../src/akuma/akuma-observe.js";
import type { ActivityRow, OutcomeRow } from "../src/akuma/projection.js";
import { compactTimelineItem } from "../src/akuma/timeline-text.js";
import {
  DEFAULT_CONTEXT,
  historyText,
  killResultText,
  snapshotText,
  tellText,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import {
  askFrame,
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
  assert.equal(lines[2], `2 ${note.text}`);
  assert.match(lines[3]!, /^● running$/u);
  assert.ok(lines.indexOf("  changes") > 3, "reported changes follow the conclusion, subordinate");
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
      events: events.map(compactTimelineItem),
      omitted: 2,
      lowestRetainedSequence: 1,
      highestSequence: 8,
    },
    {}
  );
  for (const evidence of [
    "first input", "spoken line", "indented line", "hidden reasoning", "a note", "echo ok", "exit 1",
    "pending input", "the answer", "… 2 omitted",
  ])
    assert.ok(text.includes(evidence), evidence);
});

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

test("history renders the full exact report without confusing it with an outcome", () => {
  const text = ` report\n  ${"complete ".repeat(60)}\nthird\nfourth\n`;
  assert.equal(
    historyText(
      {
        kind: "akuma-report",
        akumaId: parseAkumaId("aku/elite/b9977141").id,
        sequence: 5, bodySequence: 1, turnSequence: 2, at: AKUMA_ACTIVITY_AT, text,
      },
      { id: "report/5" }
    ),
    text,
  );
});

test("history keeps long call and Tell inputs to one bounded input line", () => {
  const text = "Final minimal correction ".repeat(12);
  const rows: readonly ActivityRow[] = [
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
      events: rows.map(compactTimelineItem),
      lowestRetainedSequence: 1,
      highestSequence: 2,
    },
    {}
  ).split("\n");
  assert.deepEqual(lines.slice(1), [
    "▸ 1",
    `  ${text.slice(0, 160)}…`,
    "⧗ 2",
    `  ${text.slice(0, 160)}…`,
  ]);
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
      {}
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
  alias?: string,
): string {
  return waitText(
    { kind: "akuma", reason: "completed", results: [waitItem(status, rows)] },
    { ...(alias === undefined ? {} : { alias }) }
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
    {}
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

test("wait keeps the exact-turn answer beyond the preview aperture", () => {
  const id = "aku/worker/abcd0111";
  const long = "👩‍💻".repeat(175);
  const rows = [answeredOutcome(1, `${long}\n  detail\nthird\nfourth\n`)];
  const status = statusOf(id, "asleep", rows);
  assert.equal(singleWait(status, rows), `✓ ${id} — answered\n  turn/1 · answered\n  ${long}\n    detail\n  third\n  fourth\n`);
});

test("wait keeps a single-target alias and none in plural output", () => {
  const status = statusOf("aku/worker/abcd0112", "asleep", []);
  assert.equal(singleWait(status, [], "@scout"), "✓ aku/worker/abcd0112 (@scout) — completed");
  const other = statusOf("aku/worker/abcd0113", "asleep", []);
  const plural = waitText(
    {
      kind: "akuma",
      reason: "completed",
      results: [waitItem(status, []), waitItem(other, [])],
    },
    { alias: "@scout" }
  );
  assert.doesNotMatch(plural, /@scout/u, "an ambiguous alias is not attached to any member");
});

test("Tell admission and final Ask answer retain their distinct native facts", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const answer = { akumaId: id, tellId: "tell-id", kind: "answered" as const, answer: "exact answer" };
  assert.equal(askRawAnswer(answer), JSON.stringify("exact answer"));
  const tell = { kind: "admitted" as const, akumaId: id, tellId: "tell-id" };
  const standalone = tellText(tell, "continue", undefined);
  assert.equal(standalone, "✓ told aku/worker/deadbeef — continue", "verdict, subject, and input on one line");
  assert.equal(renderAskText(answer, undefined), JSON.stringify("exact answer"));
  assert.equal(askResultText(answer, undefined), `✓ answered ${id}\n  input tell-id`);
  const longPrompt = "one line of caller input ".repeat(20);
  const receipt = tellText(tell, longPrompt, undefined).split("\n");
  assert.equal(receipt.length, 1, "one receipt line even past the terminal width");
  assert.match(receipt[0]!, /^✓ told aku\/worker\/deadbeef — one line of caller input .*…$/u);
  assert.doesNotMatch(
    receipt.join("\n"),
    /running|completed|pending tell|─|"$/u,
    "an action receipt has no frame and adds no quotes",
  );
  assert.match(
    tellText({ ...tell, wake: { kind: "pending" } }, longPrompt, undefined),
    /^⧗ tell aku\/worker\/deadbeef — one line of caller input .*…$/mu,
    "a pending Tell keeps neutral vocabulary and the pending mark",
  );
  assert.equal(
    tellText({ ...tell, kind: "failed", failures: [{ stage: "wake", diagnostic: "wake refused" }] }, "continue", undefined),
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

test("Ask's logical live row safely spells complete identity and supplied work", () => {
  assert.equal(askFrame(2_900, SPECIMEN_ID, undefined), `${SPECIMEN_ID} ask 2s`);
  const status = {
    life: "running" as const,
    work: { kind: "open" as const, summary: { id: 2, text: "read 👩‍💻\\\u001b…", clipped: true as const } },
  };
  assert.equal(
    askFrame(4_000, SPECIMEN_ID, "@é", status),
    String.raw`${SPECIMEN_ID} (@\u{e9}) ask 4s last running | activity 2 read \u{1f469}\u{200d}\u{1f4bb}\\\u{1b}\u{2026}`,
  );
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
  const lines = historyText({ kind: "akuma", akumaId: parseAkumaId("aku/worker/abcd1234").id, events: events.map(compactTimelineItem) }, {});
  assert.match(lines, /path  src\/unknown\.ts\n  detail  ~/u);
  assert.match(lines, /path  src\/known\.ts\n  detail  \+2 -1/u);
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
  assert.deepEqual(
    renderCallText(spawned(), { cwd: "/work/repo" }).split("\n"),
    ["✓ spawned aku/worker/1234abcd", "  /work/repo"],
    "a prompt-free birth is an action receipt with its invocation directory subordinate",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ alias: { kind: "moved", previousAkumaId: parseAkumaId("aku/worker/9999beef").id } }),
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
      { cwd: "/work/repo" },
    ).split("\n"),
    ["! spawned aku/worker/1234abcd", "  /work/repo", "  ! dispatch failed infrastructure busy"],
    "a failed dispatch stage marks the receipt instead of standing under an unqualified success",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ kind: "failed", failures: [{ stage: "birth", kind: "infrastructure", diagnostic: "window lost" }] }),
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
      { cwd: "/work/repo", prompt: "exact prompt" },
    ).split("\n"),
    [
      "! spawned aku/worker/1234abcd",
      "  /work/repo",
      "  input tell/specimen",
      "  exact prompt",
      "  ! tell failed infrastructure window lost",
      "  attempted input tell/attempted",
    ],
    "an attempted Tell coordinate survives beneath the failed spawn verdict",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ dispatchWarning: "private-state-seat-close-failed seat closed late" }),
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
  const started = compactTell({ action: { kind: "started", historyId: "turn/17" } });
  const steering = compactTell({ action: { kind: "steering", historyId: "turn/17" } });
  assert.equal(tellText(started, "go", "@fleet-desk"), "✓ @fleet-desk started turn/17");
  assert.equal(tellText(steering, "go", "@fleet-desk"), "✓ @fleet-desk steered turn/17");
  assert.equal(tellText(started, "go", undefined), "✓ aku/worker/1234abcd started turn/17");
  assert.equal(tellText(started, "go", undefined, true), "✓ tell aku/worker/1234abcd\n  started turn/17");
  assert.equal(
    tellText(compactTell(), '  he said "wait"\n', "@tired"),
    '✓ told aku/worker/1234abcd (@tired) — he said "wait"',
    "the non-settled preview folds whitespace and preserves literal quotes",
  );
  assert.equal(tellText(compactTell(), "   ", undefined), "✓ told aku/worker/1234abcd");
  assert.deepEqual(
    tellText(compactTell({ wake: { kind: "pending" } }), "go", undefined).split("\n"),
    ["⧗ tell aku/worker/1234abcd — go", "  wake pending"],
    "a pending Tell keeps the pending mark and asserts no delivery",
  );
  assert.deepEqual(
    tellText(compactTell({ kind: "failed", failures: [{ stage: "wake", diagnostic: "wake refused" }] }), "go", undefined).split("\n"),
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
      kind: "failed", failures: [{ stage: "wake",
      diagnostic: `  wake\nrefused\t\u001b ${detail}`,
      logPath: path }],
    }),
    "go",
    undefined
  ).split("\n");
  assert.equal(lines[1], `  ! tell delivery failed · log ${path}`);
  assert.equal(lines.slice(2).map((line) => line.slice(4)).join("\n"), `  wake\nrefused � ${detail}`);
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
  assert.equal(lines[2], "2 edited");
  assert.equal(lines[3], "● running", "the activity closes on one truthful conclusion");
  assert.deepEqual(
    lines.slice(4),
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
    failedReads.split("\n").slice(4),
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
  const cwd = `/work/${"very-deep-directory/".repeat(12)}path`;
  const status = statusOf(id, "running", rows, { cwd });
  const view = observation(status, { kind: "associated", contractId: contractId("kei/narrow-columns") });
  const text = snapshotText(view, context);
  assert.equal(text, snapshotText(view, { ...context, columns: 120 }));
  assert.deepEqual(text.split("\n").slice(0, 2), [`${id} · kei/narrow-columns`, `  ${cwd}`]);
  assert.ok(text.includes("👩‍💻"), "whole graphemes survive preview rendering");
});
