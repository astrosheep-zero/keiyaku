import assert from "node:assert/strict";
import test from "node:test";
import { akumaStatusSchema, type AkumaStatus } from "../src/akuma/akuma.js";
import {
  type ActivityHistory,
  type ActivityRow,
  type OpenSnapshotRow,
  type OutcomeRow,
} from "../src/akuma/projection.js";
import {
  activityStream,
  callObservationStream,
  DEFAULT_CONTEXT,
  frameRule,
  historyText,
  killResultText,
  snapshotActivityLines,
  snapshotText,
  tellText,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import {
  askProgressStream,
  renderCallText,
  renderForkText,
  renderKillText,
  waitedTellProgress,
} from "../src/cli/render/akuma.js";
import { askRawAnswer } from "../src/cli/render/akuma-activity.js";
import { akumaMark } from "../src/cli/render/marks.js";
import { parseAkumaId } from "../src/akuma/identity.js";
import type { AkumaAskObservation, AkumaObservation, AkumaTellResult, AkumaWaitItem } from "../src/akuma/selection-observation.js";
import { projectStatusTimeline } from "../src/akuma/status-projection.js";
import type { CreatedDebtObservation, DispatchAssociation } from "../src/index.js";
import type { ForkResult, SpawnResult } from "../src/library/akuma-creation.js";
import { contractId } from "../src/core/facts/types.js";
import { debtIdSchema } from "../src/debt/identity.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { displayColumns, padToDisplay } from "../src/cli/render/terminal.js";
import {
  activeTool,
  answeredOutcome,
  completedTool,
  idleAkumaSnapshot,
  openAkumaSnapshot,
  snapshotRow,
  AKUMA_ACTIVITY_AT,
  reportedFileChange,
} from "./support/kanshi-activity.js";

const DIRECT_BIRTH = { origin: { kind: "direct" }, caller: { kind: "unknown" } } as const;

/** One native selected observation over a status row; absence stays absent. */
function observation(
  status: AkumaStatus,
  association: DispatchAssociation = { kind: "none" },
  extra: Readonly<{ createdDebts?: CreatedDebtObservation }> = {},
): AkumaObservation {
  const created = extra.createdDebts;
  return {
    kind: "akuma",
    id: status.id,
    life: status.life,
    cwd: status.cwd ?? "/work/repo",
    provider: status.provider ?? "fixture",
    timeline: projectStatusTimeline(status.timeline),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
    ...(association.kind === "none" ? {} : { contract: association }),
    ...(created === undefined ? {} : created.kind === "failed" ? { createdDebts: created } :
      created.rows === undefined ? {} : { createdDebts: created.rows.map(({ id, title, priority, disposition }) => ({ id, title, priority, disposition })) }),
    ...(status.timeline.reportedChanges.length === 0 ? {} : {
      changes: status.timeline.reportedChanges.map(({ path, diffstat }) => ({ path, ...(diffstat === undefined ? {} : { diffstat }) })),
    }),
    ...(status.timeline.reportedChangesOmitted === 0 ? {} : { moreChanges: true }),
  };
}

function running(id: string, rows: readonly OpenSnapshotRow[]) {
  return akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "running",
    timeline: openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))),
  });
}

function liveObservation(status: AkumaStatus, rows: readonly ActivityRow[]) {
  return { status, rows, ordinarySelected: 0 };
}

test("status panel puts static coordinates above the timeline and dynamic facts below", () => {
  const id = "aku/worker/abcd1234";
  const note: ActivityRow = { kind: "note", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "edited" };
  const status = akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "running",
    cwd: "/work/appointed",
    timeline: openAkumaSnapshot([{ kind: "row", row: note }], [reportedFileChange("/work/file")]),
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
  assert.match(lines[3]!, /note +edited$/u);
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

test("selected status keeps the last three rendered activity lines, not three events", () => {
  const id = "aku/worker/abcd1234";
  const say = (sequence: number, text: string): OpenSnapshotRow => ({
    kind: "said",
    sequence,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text,
  });
  const render = (rows: readonly OpenSnapshotRow[]) =>
    snapshotText(observation(running(id, rows)), { columns: 40, color: false });
  assert.doesNotMatch(render([]), /omitted/u);
  assert.doesNotMatch(render([say(1, "only")]), /omitted/u);
  const text = render([say(1, "old one\nold two"), say(2, "new 👩‍💻\nnew two")]);
  assert.match(text, /earlier activity omitted/u);
  assert.doesNotMatch(text, /old one/u);
  assert.match(text, /old two\n▎ new 👩‍💻\n▎ new two/u);
  assert.match(text, /● running/u);
});

test("selected status merges gaps and budgeted-away speech into one omission run", () => {
  const view: AkumaObservation = {
    ...observation(running("aku/worker/abcd1234", [])),
    timeline: {
      kind: "open",
      entries: [
        ...Array.from({ length: 30 }, (_, index) => [
          { kind: "gap" as const },
          { kind: "said" as const, text: `old ${index}` },
        ]).flat(),
        { kind: "said", text: "last one" },
        { kind: "said", text: "last two" },
        { kind: "said", text: "last three" },
      ],
    },
  };
  const lines = snapshotText(view, { columns: 40, color: false }).split("\n");
  assert.deepEqual(lines.slice(3, -1), [
    "   ···    earlier activity omitted",
    "▎ last one",
    "▎ last two",
    "▎ last three",
  ]);
});

test("speech uses the rail without a label or quotes and wraps at a grapheme boundary", () => {
  const row: ActivityRow = {
    kind: "said",
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "👩‍💻".repeat(45),
  };
  const lines = snapshotActivityLines(openAkumaSnapshot([{ kind: "row", row }]), { columns: 40, color: false });
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines.join("\n"), /say|[“”]/u);
  assert.match(lines[0]!, /^▎ 👩‍💻/u);
  assert.match(lines[1]!, /^▎ 👩‍💻/u);
  assert.match(lines[1]!, /…$/u);
  for (const line of lines) assert.ok(displayColumns(line) <= 40);
});

test("the shared timeline grammar renders input, speech, actions, outcomes, and gaps left-flowing", () => {
  const entries = [
    snapshotRow({
      kind: "call" as const,
      sequence: 1,
      turnSequence: 1,
      at: AKUMA_ACTIVITY_AT,
      text: "first input",
    }),
    snapshotRow({
      kind: "said" as const,
      sequence: 2,
      turnSequence: 1,
      at: AKUMA_ACTIVITY_AT,
      text: "spoken line\n  indented line",
    }),
    snapshotRow({
      kind: "thought" as const,
      sequence: 3,
      turnSequence: 1,
      at: AKUMA_ACTIVITY_AT,
      text: "hidden reasoning",
    }),
    snapshotRow({ kind: "note" as const, sequence: 4, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "a note" }),
    snapshotRow(completedTool(5, "bash", { kind: "run", command: "echo ok" })),
    snapshotRow(completedTool(6, "bash", { kind: "run", command: "false" }, { status: "error", exitCode: 1 })),
    snapshotRow({
      kind: "tell" as const,
      sequence: 7,
      at: AKUMA_ACTIVITY_AT,
      tellId: "tell/grammar",
      text: "pending input",
      state: "pending" as const,
      deliveries: [],
    }),
    { kind: "gap" as const, count: 2 },
  ];
  const lines = snapshotActivityLines(idleAkumaSnapshot(entries, answeredOutcome(8, "the answer")), {
    columns: 72,
    color: false,
  });
  assert.deepEqual(lines, [
    "▸ first input",
    "▎ spoken line",
    "▎   indented line",
    "   think  hidden reasoning",
    "   note   a note",
    "   run    $ echo ok",
    "!  run    $ false — exit 1",
    "⧗ pending input",
    "   ···    2 omitted",
    "✓ the answer",
  ]);
});

test("bounded paragraph previews never spend their last line on a blank", () => {
  const context = { columns: 40, color: false };
  const answer =
    "the first paragraph wraps across two lines before the blank\n\nthe second paragraph begins after a blank source line and keeps going";
  const lines = snapshotActivityLines(idleAkumaSnapshot([], answeredOutcome(1, answer)), context);
  assert.equal(lines.length, 3, "the preview stays inside its three-line budget");
  for (const line of lines) {
    assert.ok(displayColumns(line) <= 40, line);
    assert.notEqual(line.replace(/…$/u, "").trim(), "", "a content-carrying line is never blank");
  }
  assert.match(lines[2]!, /^ {2}the second paragraph/u, "content wins the final line over the paragraph break");
  assert.match(lines[2]!, /…$/u, "the bounded preview names its truncation");
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
  for (const line of lines) assert.ok(displayColumns(line) <= 64, line);
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
  const status = akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id: "aku/worker/abcd1234",
    life: "asleep",
    timeline: idleAkumaSnapshot([{ kind: "row", row: pending }]),
  });
  assert.match(snapshotText(observation(status), DEFAULT_CONTEXT), /⧗ follow up\n⧗ pending tell$/u);
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

function waitItem(status: AkumaStatus): AkumaWaitItem {
  const pending = status.timeline.entries.some((entry) =>
    entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending",
  );
  const outcome = status.timeline.kind === "idle" ? status.timeline.outcome : undefined;
  return {
    kind: "observed",
    id: status.id,
    life: status.life,
    ...(pending ? { pending: true } : {}),
    ...(outcome === undefined ? {} : { outcome: { ...outcome.outcome, historyId: `turn/${outcome.turnSequence}` as const } }),
    ...(status.strandedReason === undefined ? {} : { strandedReason: status.strandedReason }),
  };
}

function waitStatus(
  id: string,
  life: AkumaStatus["life"],
  timeline: AkumaStatus["timeline"],
  extra: { strandedReason?: "resume-unsupported" } = {},
): AkumaStatus {
  return akumaStatusSchema.parse({ birth: DIRECT_BIRTH, id, life, timeline, ...extra });
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

function singleWait(status: AkumaStatus, columns = 120, alias?: string): string {
  return waitText(
    { kind: "akuma", reason: "completed", results: [waitItem(status)] },
    { ...(alias === undefined ? {} : { alias }) },
    { columns, color: false },
  );
}

test("wait renders one compact line per member from its final public snapshot", () => {
  const members = [
    waitStatus("aku/worker/abcd0101", "asleep", idleAkumaSnapshot([], answeredOutcome(1, "the answer"))),
    waitStatus("aku/worker/abcd0102", "asleep", idleAkumaSnapshot([])),
    waitStatus("aku/worker/abcd0103", "asleep", idleAkumaSnapshot([], failedOutcome(1, "provider 503"))),
    waitStatus("aku/worker/abcd0104", "running", openAkumaSnapshot([])),
    waitStatus("aku/worker/abcd0105", "killed", idleAkumaSnapshot([], answeredOutcome(1, "stale answer"))),
    waitStatus("aku/worker/abcd0106", "hung", openAkumaSnapshot([])),
    waitStatus("aku/worker/abcd0107", "untidy", openAkumaSnapshot([])),
    waitStatus("aku/worker/abcd0108", "stranded", openAkumaSnapshot([]), { strandedReason: "resume-unsupported" }),
    waitStatus("aku/worker/abcd0109", "asleep", idleAkumaSnapshot([snapshotRow(pendingTellRow(1))])),
    waitStatus("aku/worker/abcd0110", "running", openAkumaSnapshot([snapshotRow(pendingTellRow(1))])),
  ];
  const text = waitText(
    { kind: "akuma", reason: "completed", results: members.map(waitItem) },
    {},
    { columns: 120, color: false },
  );
  assert.equal(
    text,
    [
      "✓ aku/worker/abcd0101 — the answer",
      "✓ aku/worker/abcd0102 — completed",
      "! aku/worker/abcd0103 — provider 503",
      "● aku/worker/abcd0104 — running",
      "× aku/worker/abcd0105 — killed",
      "? aku/worker/abcd0106 — hung",
      "! aku/worker/abcd0107 — untidy",
      "! aku/worker/abcd0108 — stranded · resume-unsupported",
      "⧗ aku/worker/abcd0109 — pending tell",
      "● aku/worker/abcd0110 — running · pending tell",
    ].join("\n"),
    "one left-flowing line per member, in result order, with a stopped life over any older answer",
  );
  assert.doesNotMatch(text, /\n\n/u, "no blank block separators");
  assert.doesNotMatch(text, /\d{2}:\d{2}/u, "no wall clocks");
  assert.doesNotMatch(text, /─|changes|debts|stale answer/u, "no frame, timeline, change, Debt, or stale answer dump");
});

test("wait bounds its summary to the terminal and never truncates identity", () => {
  const id = "aku/worker/abcd0111";
  const status = waitStatus(
    id,
    "asleep",
    idleAkumaSnapshot([], answeredOutcome(1, "a very long answered preview that cannot fit")),
  );
  const narrow = singleWait(status, 40);
  assert.ok(narrow.startsWith(`✓ ${id} — `), "the mark, complete identity, and separator survive");
  assert.ok(displayColumns(narrow) <= 40, "the summary never exceeds the terminal");
  assert.match(narrow, /…$/u, "a bounded summary exposes its own truncation");
  const wide = singleWait(status, 200);
  assert.equal(
    wide,
    `✓ ${id} — a very long answered preview that cannot fit`,
    "available width keeps the whole preview",
  );
});

test("wait keeps a single-target alias and none in plural output", () => {
  const status = waitStatus("aku/worker/abcd0112", "asleep", idleAkumaSnapshot([]));
  assert.equal(singleWait(status, 120, "@scout"), "✓ aku/worker/abcd0112 (@scout) — completed");
  const plural = waitText(
    {
      kind: "akuma",
      reason: "completed",
      results: [waitItem(status), waitItem(waitStatus("aku/worker/abcd0113", "asleep", idleAkumaSnapshot([])))],
    },
    { alias: "@scout" },
    DEFAULT_CONTEXT,
  );
  assert.doesNotMatch(plural, /@scout/u, "an ambiguous alias is not attached to any member");
});

test("waited Tell reserves stdout for its exact answer and keeps one JSON envelope", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const context = { columns: 80, color: false };
  const answer = { akumaId: id, tellId: "tell-id", kind: "answered" as const, answer: "exact answer" };
  assert.equal(askRawAnswer(answer, undefined), "exact answer");
  const tell = { akumaId: id, tellId: "tell-id" };
  const standalone = tellText(tell, "continue", undefined, context);
  assert.equal(standalone, "✓ told aku/worker/deadbeef — continue", "verdict, subject, and input on one line");
  const progress = waitedTellProgress(answer, { prompt: "continue" }, context);
  assert.match(progress, /▸ continue/u, "the panel keeps its timeline input row for admitted input");
  assert.equal(progress.match(/^aku\/worker\/deadbeef$/gmu)?.length, 1, "one identity frame");
  assert.equal(progress.match(/▸ continue/gu)?.length, 1, "the admission row is not replayed");
  assert.match(progress, /✓ answered\n\n$/u, "the progress conclusion separates stdout answer bytes");
  const longPrompt = "one line of caller input ".repeat(20);
  const receipt = tellText(tell, longPrompt, undefined, context).split("\n");
  assert.equal(receipt.length, 1, "one receipt line even past the terminal width");
  assert.match(receipt[0]!, /^✓ told aku\/worker\/deadbeef — one line of caller input .*…$/u);
  assert.doesNotMatch(
    receipt.join("\n"),
    /running|completed|pending tell|─|"$/u,
    "an action receipt has no frame and adds no quotes",
  );
  assert.ok(displayColumns(receipt[0]!) <= 80);
  assert.match(
    tellText({ ...tell, wake: { kind: "pending" } }, longPrompt, undefined, context),
    /^⧗ tell aku\/worker\/deadbeef — one line of caller input .*…$/mu,
    "a pending Tell keeps neutral vocabulary and the pending mark",
  );
  assert.equal(
    tellText({ ...tell, wake: { kind: "failed", diagnostic: "wake refused" } }, "continue", undefined, context),
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

  assert.equal(askRawAnswer({ ...answer, answer: "decoded scalar" }, true), '"decoded scalar"');
});

test("call and bounded Tell share one input frame and pinned conclusion", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const context = { columns: 100, color: false };
  const startedAt = Date.parse(AKUMA_ACTIVITY_AT) - 5_000;
  const tell = {
    admission: { fact: "recorded" as const, tellId: "tell-bound" },
    row: {
      kind: "tell" as const,
      sequence: 1,
      at: new Date(startedAt).toISOString(),
      tellId: "tell-bound",
      text: "continue",
      state: "told" as const,
      deliveries: [],
    },
    wake: { kind: "told" as const },
  };
  const status = running(id, [tell.row]);
  const call = callObservationStream(context, { id, contract: { kind: "none" }, facts: [] }, { now: () => startedAt });
  const callFrame = call.observe({ status, rows: [tell.row] });
  const callConclusion = call.conclude({
    akumaId: id,
    tellId: "tell-bound",
    input: { kind: "answered", answer: "exact answer" },
  });

  const progress = askProgressStream(undefined, undefined, context);
  const admission = progress.admitted(tell, id);
  const tellFrame = progress.observe(liveObservation(status, [tell.row]));
  const tellConclusion = progress.conclude({
    akumaId: id,
    tellId: "tell-bound",
    kind: "answered",
    answer: "exact answer",
  });
  const tellTranscript = [...admission, ...tellFrame, ...tellConclusion].join("\n");
  const callTranscript = [...callFrame, callConclusion].join("\n");
  assert.equal(admission[0], id, "the shared stream opens the identity frame before the Tell receipt");
  assert.equal(admission[1], "─".repeat(displayColumns(id)));
  assert.equal(tellTranscript.match(/▸ continue/gu)?.length, 1);
  assert.ok(tellTranscript.indexOf("continue") > tellTranscript.indexOf(`${id}\n`));
  assert.equal(tellTranscript.split(id).length - 1, 1, "the transcript contains exactly one identity frame");
  assert.equal(callTranscript.match(/▸ continue/gu)?.length, 1);
  assert.ok(callTranscript.indexOf("continue") > callTranscript.indexOf(`${id}\n`));
  assert.equal(callTranscript.split(id).length - 1, 1, "the call transcript contains exactly one identity frame");
  assert.equal(tellFrame.length, 0, "the admitted Tell receipt is not replayed by observation");
  assert.equal(tellConclusion.length, 1);
  assert.equal(tellConclusion[0], callConclusion);
  assert.match(callConclusion, /✓ answered/u, "both adapters share one input-wait conclusion");
});

test("ask activity starts at admission and includes a later settlement of an older tool", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const opening: OpenSnapshotRow = { kind: "call", sequence: 1, turnSequence: 1, at: at(0), text: "original input" };
  const oldNote: OpenSnapshotRow = { kind: "note", sequence: 2, turnSequence: 1, at: at(1), text: "before ask" };
  const oldActive = { ...activeTool(3, "bash", { kind: "run" as const, command: "old tool" }), at: at(2) };
  const tell = {
    admission: { fact: "recorded" as const, tellId: "tell-ask" },
    row: {
      kind: "tell" as const,
      sequence: 4,
      at: at(3),
      tellId: "tell-ask",
      text: "new question",
      state: "told" as const,
      deliveries: [],
    },
    wake: { kind: "told" as const },
  };
  const later: OpenSnapshotRow = { kind: "note", sequence: 5, turnSequence: 1, at: at(4), text: "after ask" };
  const next: OpenSnapshotRow = { kind: "note", sequence: 6, turnSequence: 1, at: at(5), text: "new activity" };
  const oldSettled = { ...completedTool(7, "bash", { kind: "run" as const, command: "old tool" }), at: at(6) };
  const status = (rows: readonly OpenSnapshotRow[]) =>
    akumaStatusSchema.parse({
      birth: DIRECT_BIRTH,
      id,
      life: "running",
      timeline: { ...openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))), openingSequence: 1 },
    });
  const stream = askProgressStream(undefined, undefined, { columns: 100, color: false });
  const admission = stream.admitted(tell, id);
  assert.match(admission.join("\n"), /▸ new question/u, "the receipt is returned before observation");
  const firstRows = [opening, oldNote, oldActive, tell.row, later];
  const first = stream.observe(liveObservation(status(firstRows), firstRows));
  assert.deepEqual(first, ["   ···    1 omitted"], "only post-admission settled evidence counts as omitted");
  const secondRows = [opening, oldNote, tell.row, later, next, oldSettled];
  const second = stream.observe(liveObservation(status(secondRows), secondRows));
  assert.match(second.join("\n"), /new activity/u);
  assert.match(second.join("\n"), /old tool/u);
  assert.deepEqual(stream.observe(liveObservation(status(secondRows), secondRows)), [], "later activity streams once");
  const answer = { akumaId: id, tellId: "tell-ask", kind: "answered" as const, answer: "exact\nanswer" };
  const conclusion = stream.conclude(answer);
  const transcript = [...admission, ...first, ...second, ...conclusion].join("\n");
  assert.equal((transcript.match(/new question/gu) ?? []).length, 1);
  assert.equal((transcript.match(/new activity/gu) ?? []).length, 1);
  assert.doesNotMatch(transcript, /original input|before ask|after ask/u);
  assert.equal(transcript.match(/old tool/gu)?.length, 1);
  assert.ok(transcript.indexOf("new question") < transcript.indexOf("new activity"));
  assert.match(transcript, /✓ answered\n\n$/u);
  assert.equal(askRawAnswer(answer, undefined), "exact\nanswer");
});

test("ask seed marks eligible omissions before a newer Turn opening in timeline order", () => {
  const id = parseAkumaId("aku/worker/deadbeef").id;
  const at = AKUMA_ACTIVITY_AT;
  const tell = {
    admission: { fact: "recorded" as const, tellId: "tell-ask" },
    row: {
      kind: "tell" as const,
      sequence: 4,
      at,
      tellId: "tell-ask",
      text: "question",
      state: "told" as const,
      deliveries: [],
    },
    wake: { kind: "told" as const },
  };
  const earlier: OpenSnapshotRow = { kind: "note", sequence: 2, turnSequence: 1, at, text: "earlier" };
  const beforeOpening: OpenSnapshotRow = {
    kind: "note",
    sequence: 5,
    turnSequence: 1,
    at,
    text: "eligible but skipped",
  };
  const opening: OpenSnapshotRow = { kind: "call", sequence: 6, turnSequence: 2, at, text: "next turn" };
  const afterOpening: OpenSnapshotRow = { kind: "note", sequence: 7, turnSequence: 2, at, text: "also skipped" };
  const live: OpenSnapshotRow = { kind: "note", sequence: 8, turnSequence: 2, at, text: "live update" };
  const status = (rows: readonly OpenSnapshotRow[]) =>
    akumaStatusSchema.parse({
      birth: DIRECT_BIRTH,
      id,
      life: "running",
      timeline: {
        ...openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))),
        turn: { kind: "turn" as const, sequence: 6, bodySequence: 2, at },
        openingSequence: 6,
      },
    });
  const rows = [earlier, tell.row, beforeOpening, opening, afterOpening];
  const stream = askProgressStream(undefined, undefined, { columns: 100, color: false });
  const receipt = stream.admitted(tell, id);
  const baseline = stream.observe(liveObservation(status(rows), rows));
  assert.equal(baseline.length, 3);
  assert.match(baseline[0]!, /··· +1 omitted/u);
  assert.match(baseline[1]!, /▸ next turn/u);
  assert.match(baseline[2]!, /··· +1 omitted/u);
  const later = stream.observe(liveObservation(status([...rows, live]), [...rows, live]));
  assert.match(later.join("\n"), /live update/u);
  assert.deepEqual(stream.observe(liveObservation(status([...rows, live]), [...rows, live])), []);
  const transcript = [...receipt, ...baseline, ...later].join("\n");
  assert.ok(transcript.indexOf("question") < transcript.indexOf("next turn"));
  assert.ok(transcript.indexOf("next turn") < transcript.indexOf("live update"));
  assert.doesNotMatch(transcript, /earlier|eligible but skipped|also skipped/u);
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

test("an open turn settles old says on the rail and only its trailing say flushes unresolved", () => {
  const oldSay: OpenSnapshotRow = {
    kind: "said",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "old settled say",
  };
  const tools = [3, 4, 5, 6].map((sequence) =>
    completedTool(sequence, "bash", { kind: "run", command: `after-say-${sequence}` }),
  );
  const trailingSay: OpenSnapshotRow = {
    kind: "said",
    sequence: 7,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "still streaming",
  };
  const rows = [oldSay, ...tools, trailingSay];
  const stream = activityStream({ columns: 80, color: false });
  const settled = stream({
    snapshot: openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))),
    rows,
  });
  assert.ok(
    settled.some((line) => line.includes("▎ old settled say")),
    "a say with a successor settles on the rail",
  );
  assert.ok(!settled.some((line) => line.includes("?")), "a settled say never prints as unresolved");
  const live = stream.frame();
  assert.ok(!live.some((line) => line.includes("old settled say")), "a settled say never enters the live frame");
  const liveSay = live.find((line) => line.includes("still streaming"))!;
  assert.match(liveSay, /^▎ still streaming$/u, "only the open turn's trailing say stays live");
  assert.ok(liveSay.includes("still streaming"), "the trailing say's text is live");
  assert.doesNotMatch(liveSay, /[“”]/u, "live speech has no added quote boundary");
  const flushed = stream.flush();
  assert.ok(
    flushed.some((line) => line === "▎ still streaming"),
    "only the trailing say flushes, on its rail",
  );
  assert.ok(!flushed.some((line) => line.includes("old settled say")), "a settled say is never flushed");
  assert.ok(!flushed.some((line) => line.includes("after-say-6")), "an in-flight final say omits prior tail tools");
  assert.ok(
    flushed.some((line) => line.includes("···    1 omitted")),
    "the earlier tool stays accounted for",
  );
});

test("display-width padding measures cells, so a wide emoji alias cannot skew its column", () => {
  assert.equal(displayColumns("🕷️"), 2);
  assert.equal(padToDisplay("🕷️", 4), "🕷️  ");
  assert.equal(displayColumns(padToDisplay("🕷️", 4)), 4);
  assert.equal(padToDisplay("@ab", 4), "@ab ");
  const column = (label: string): string => `${padToDisplay(label, 4)}|`;
  assert.equal(
    displayColumns(column("🕷️")),
    displayColumns(column("ab")),
    "a wide emoji and a two-cell name open the next column at the same place",
  );
});

test("changes section renders unknown diffstat as ~ and known as +a -r", () => {
  const status = akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id: "aku/worker/abcd1234",
    life: "running",
    timeline: openAkumaSnapshot(
      [],
      [
        reportedFileChange("/work/unknown"),
        { ...reportedFileChange("/work/known"), diffstat: { added: 3, removed: 1 } },
      ],
    ),
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
  const lines = snapshotActivityLines(
    openAkumaSnapshot([
      {
        kind: "row",
        row: completedTool(1, "edit", { kind: "fileChange", changes: [{ op: "add", path: "src/unknown.ts" }] }),
      },
      {
        kind: "row",
        row: completedTool(2, "edit", {
          kind: "fileChange",
          changes: [{ op: "update", path: "src/known.ts", diffstat: { added: 2, removed: 1 } }],
        }),
      },
    ]),
    { columns: 120, color: false },
  ).join("\n");
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

function tellSpecimenRow(text: string, state: "told" | "pending") {
  return {
    kind: "tell" as const,
    sequence: 1,
    at: AKUMA_ACTIVITY_AT,
    tellId: "tell/specimen",
    text,
    state,
    deliveries: [],
  };
}

function compactTell(wake?: AkumaTellResult["wake"]) {
  return {
    akumaId: SPECIMEN_ID,
    tellId: "tell/specimen",
    ...(wake === undefined ? {} : { wake }),
  };
}

function spawned(extra: Partial<SpawnResult> = {}): SpawnResult {
  return { akumaId: SPECIMEN_ID, ...extra };
}

function forkReceipt(
  parent: string,
  child: string,
  extra: Partial<Extract<ForkResult, { kind: "forked" }>> = {},
): ForkResult {
  return { kind: "forked", parentAkumaId: parseAkumaId(parent).id, childAkumaId: parseAkumaId(child).id, ...extra };
}

function createdDebtRow(): Extract<NonNullable<AkumaObservation["createdDebts"]>, readonly unknown[]>[number] {
  return {
    id: debtIdSchema.parse("debt/example"),
    title: "close the rake",
    priority: 2,
    disposition: "ready",
  };
}

test("Akuma outcomes distinguish admission from failed execution", () => {
  const spawn = { akumaName: "worker" };
  const input = { akuma: SPECIMEN_ID, prompt: "go" };
  assert.equal(classifyVerb("spawn", spawn, { kind: "returned", value: spawned() }), "accepted");
  assert.equal(classifyVerb("tell", input, { kind: "returned", value: compactTell() }), "accepted");
  assert.equal(
    classifyVerb("tell", input, {
      kind: "returned",
      value: compactTell({ kind: "failed", diagnostic: "wake refused" }),
    }),
    "failed",
  );
  assert.equal(
    classifyVerb("spawn", spawn, {
      kind: "returned",
      value: spawned({
        failure: { kind: "infrastructure", diagnostic: "provider stopped" },
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

test("shared ask rendering preserves answer bytes and non-answer conclusions", () => {
  const input = { akuma: SPECIMEN_ID, prompt: "go" };
  const context = { columns: 100, color: false };
  const render = (observation: AkumaAskObservation) =>
    renderVerb(
      "ask",
      input,
      { kind: "returned", value: { akumaId: SPECIMEN_ID, tellId: "tell/specimen", ...observation } },
      context,
    );
  assert.equal(render({ kind: "answered", answer: "exact\nanswer" }), "exact\nanswer");
  assert.match(render({ kind: "failed", diagnostic: "provider stopped" }), /provider stopped/u);
  assert.match(render({ kind: "invalid-output", diagnostic: "schema mismatch", answer: "wrong" }), /schema mismatch/u);
  const deadline = render({ kind: "deadline" });
  assert.match(deadline, /pending tell/u);
  assert.doesNotMatch(deadline, /waited|NaN/u);
  assert.equal(render({ kind: "deadline" }), deadline);
  const spawn = spawned({ tellId: "tell/specimen", input: { kind: "deadline" } });
  const renderedSpawn = renderVerb("spawn", { akumaName: "worker" }, { kind: "returned", value: spawn }, context);
  assert.match(renderedSpawn, /pending tell/u);
  assert.doesNotMatch(renderedSpawn, /waited|NaN/u);
  assert.equal(
    renderVerb("spawn", { akumaName: "worker" }, { kind: "returned", value: spawn }, context),
    renderedSpawn,
  );
});

test("every action receipt leads with a verdict and subject, then indented evidence", () => {
  const context = { columns: 100, color: false };
  assert.deepEqual(
    renderCallText(spawned(), false, context, { cwd: "/work/repo" }).split("\n"),
    ["✓ spawned aku/worker/1234abcd", "  /work/repo"],
    "a prompt-free birth is an action receipt with its invocation directory subordinate",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ alias: { kind: "moved", previousAkumaId: parseAkumaId("aku/worker/9999beef").id } }),
      false,
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
      spawned({ dispatchFailure: { kind: "infrastructure", diagnostic: "busy" } }),
      false,
      context,
      { cwd: "/work/repo" },
    ).split("\n"),
    ["! spawned aku/worker/1234abcd", "  /work/repo", "  ! dispatch failed infrastructure busy"],
    "a failed dispatch stage marks the receipt instead of standing under an unqualified success",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ failure: { kind: "infrastructure", diagnostic: "window lost" } }),
      false,
      context,
      { cwd: "/work/repo" },
    ).split("\n"),
    ["! spawned aku/worker/1234abcd", "  /work/repo", "  ! infrastructure · window lost"],
    "a detached failure without an admitted Tell stays an action receipt over the born child",
  );
  assert.deepEqual(
    renderCallText(
      spawned({
        tellId: "tell/specimen",
        failure: { kind: "infrastructure", diagnostic: "window lost", attemptedTellId: "tell/attempted" },
      }),
      false,
      context,
      { cwd: "/work/repo", prompt: "exact prompt" },
    ).split("\n"),
    [
      "! spawned aku/worker/1234abcd",
      "  /work/repo",
      '  "exact prompt"',
      "  ! infrastructure · window lost",
      "  attempted input tell/attempted",
    ],
    "an attempted Tell coordinate survives beneath the failed spawn verdict",
  );
  assert.deepEqual(
    renderCallText(
      spawned({ dispatchWarning: "private-state-seat-close-failed seat closed late" }),
      false,
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
      forkReceipt("aku/worker/9999beef", "aku/worker/5678abcd", {
        dispatchFailure: { kind: "publication-failed", diagnostic: "read-only mirror" },
      }),
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
    tellText(compactTell({ kind: "pending" }), "go", undefined, context).split("\n"),
    ["⧗ tell aku/worker/1234abcd — go", "  wake pending"],
    "a pending Tell keeps the pending mark and asserts no delivery",
  );
  assert.deepEqual(
    tellText(compactTell({ kind: "failed", diagnostic: "wake refused" }), "go", undefined, context).split("\n"),
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
      kind: "failed",
      diagnostic: `  wake\nrefused\t\u001b ${"👩‍💻".repeat(100)}`,
      logPath: path,
    }),
    "go",
    undefined,
    context,
  ).split("\n");
  assert.equal(lines[1], `  ! tell delivery failed · log ${path}`);
  const payload = lines.slice(2);
  assert.equal(payload.length, 3, "the cause retains the shared bounded line budget");
  assert.match(payload[0]!, /^ {4}wake refused � 👩‍💻/u, "cause text is terminal-safe and whitespace-folded");
  assert.ok(payload.every((line) => line.startsWith("    ") && displayColumns(line) <= context.columns));
  assert.match(payload.at(-1)!, /…$/u, "the cause names its own omission");
  assert.match(payload.slice(1).join("\n"), /^(?: {4}(?:👩‍💻)+…?\n?)+$/u, "wrapping keeps whole graphemes");
});

test("created Debt observations use the shared dropped disposition", () => {
  const status = waitStatus("aku/worker/abcd1234", "asleep", idleAkumaSnapshot([]));
  const text = snapshotText(
    observation(
      status,
      { kind: "none" },
      { createdDebts: { kind: "present", rows: [{ ...createdDebtRow(), disposition: "drop" }] } },
    ),
    DEFAULT_CONTEXT,
  );
  assert.match(text, /debt\/example · close the rake · dropped · P2/u);
});

test("an observation panel orders identity, context, activity, conclusion, outputs, and diagnostics", () => {
  const id = "aku/worker/abcd1234";
  const context = { columns: 100, color: false };
  const status = akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "running",
    cwd: "/work/appointed",
    timeline: openAkumaSnapshot(
      [{ kind: "row", row: { kind: "note", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "edited" } }],
      [reportedFileChange("/work/file")],
    ),
  });
  const text = snapshotText(
    observation(
      status,
      { kind: "associated", contractId: contractId("kei/example-1234") },
      { createdDebts: { kind: "present", rows: [createdDebtRow()] } },
    ),
    context,
  );
  const lines = text.split("\n");
  const head = [`${id} · kei/example-1234`, "  /work/appointed"];
  assert.deepEqual(lines.slice(0, 2), head, "identity carries its Contract inline and context sits beneath it");
  assert.equal(lines[2], frameRule(head, context.columns), "one rule divides context from content");
  assert.match(lines[3]!, /note +edited$/u);
  assert.equal(lines[4], "● running", "the activity closes on one truthful conclusion");
  assert.deepEqual(
    lines.slice(5),
    ["  changes", "    ~  /work/file", "  debts 1", "    ○ debt/example · close the rake · ready · P2"],
    "dynamic outputs stay subordinate and no diagnostic is reported",
  );
  const failedReads = snapshotText(
    observation(
      status,
      { kind: "failed", diagnostic: "lookup refused" },
      {
        createdDebts: {
          kind: "failed",
          diagnostic: "Unmigrated ledger authority: /Users/astrosheep/.keiyaku/tasks",
        },
      },
    ),
    context,
  );
  assert.deepEqual(
    failedReads.split("\n").slice(5),
    [
      "  changes",
      "    ~  /work/file",
      "  ! created debts unavailable",
      "    Unmigrated ledger authority: /Users/astrosheep/.keiyaku/tasks",
      "  ! contract association unavailable",
      "    lookup refused",
    ],
    "failed reads name their observation subjects beneath outputs, with each cause in its own payload",
  );
});

test("a narrow panel never truncates a copyable identity and caps its rule at the terminal", () => {
  const id = "aku/worker/abcd1234";
  const context = { columns: 40, color: false };
  const status = akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "running",
    cwd: "/work/界界界/deep/path",
    timeline: openAkumaSnapshot([
      {
        kind: "row",
        row: { kind: "said", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "👩‍💻".repeat(30) },
      },
    ]),
  });
  const lines = snapshotText(
    observation(status, { kind: "associated", contractId: contractId("kei/narrow-columns") }),
    context,
  ).split("\n");
  assert.equal(lines[0], `${id} · kei/narrow-columns`, "the copyable identity is never wrapped or truncated");
  assert.equal(displayColumns(lines[2]!), 40, "the shared rule never exceeds the terminal");
  assert.ok(
    lines.slice(3).every((line) => displayColumns(line) <= 40),
    "payload and activity stay inside the terminal",
  );
  assert.ok(
    lines.some((line) => line.includes("👩‍💻")),
    "wide graphemes survive wrapping",
  );
});

test("a failed observing call keeps a known directory and its admitted Tell input exactly once", () => {
  const context = { columns: 100, color: false };
  const head = {
    id: SPECIMEN_ID,
    alias: "@scout",
    contract: { kind: "associated" as const, contractId: contractId("kei/demo") },
    facts: [] as readonly string[],
  };
  const failedObservation = (wake?: AkumaTellResult["wake"]): SpawnResult => ({
    ...spawned({ tellId: "tell/specimen", ...(wake === undefined ? {} : { wake }) }),
    failure: { kind: "infrastructure", diagnostic: "window lost" },
  });
  const stream = callObservationStream(context, { ...head, cwd: "/work/repo" }, { prompt: "exact prompt" });
  const lines = stream.conclude(failedObservation()).split("\n");
  const headLines = [`${SPECIMEN_ID} (@scout) · kei/demo`, "  /work/repo"];
  assert.deepEqual(
    lines.slice(0, 3),
    [...headLines, frameRule(headLines, context.columns)],
    "the failure panel states the known directory above the boundary and fabricates nothing",
  );
  assert.match(lines[3]!, /^▸ exact prompt$/u, "the admitted input is the panel's first evidence");
  assert.equal(lines[4], "! window lost");

  // A Tell row that already settled on the timeline is that evidence; the close must not replay it.
  const observedStream = callObservationStream(context, head, { prompt: "exact prompt" });
  const settledRow = tellSpecimenRow("exact prompt", "told");
  const settled = observedStream.observe({ status: running(SPECIMEN_ID, [settledRow]), rows: [settledRow] });
  const observedText = [...settled, observedStream.conclude(failedObservation())].join("\n");
  assert.equal((observedText.match(/exact prompt/gu) ?? []).length, 1, "a settled admission row is never replayed");
  assert.match(observedText, /! window lost\n*$/u);

  // An admission that never settled was never printed, so closing on it prints it once.
  const pendingRow = tellSpecimenRow("exact prompt", "pending");
  const pendingStream = callObservationStream(context, head, { prompt: "exact prompt" });
  const pendingSettled = pendingStream.observe({
    status: running(SPECIMEN_ID, [pendingRow]),
    rows: [pendingRow],
  });
  const pendingText = [...pendingSettled, pendingStream.conclude(failedObservation({ kind: "pending" }))].join("\n");
  assert.equal((pendingText.match(/exact prompt/gu) ?? []).length, 1);
  assert.match(pendingText, /⧗ exact prompt/u);
});
