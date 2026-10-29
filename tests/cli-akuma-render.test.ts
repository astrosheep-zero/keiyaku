import assert from "node:assert/strict";
import test from "node:test";
import { akumaStatusSchema, type AkumaStatus } from "../src/akuma/akuma.js";
import { type ActivityRow, type OpenSnapshotRow, type OutcomeRow } from "../src/akuma/projection.js";
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
  askOutcome,
  callOutcome,
  tellOutcome,
  renderCallText,
  renderForkText,
  renderKillText,
  waitedTellProgress,
} from "../src/cli/render/akuma.js";
import { askRawAnswer } from "../src/cli/render/akuma-activity.js";
import { akumaMark } from "../src/cli/render/marks.js";
import { parseAkuId } from "../src/akuma/identity.js";
import type { AkumaTellResult } from "../src/akuma/selection-observation.js";
import type { AkumaAlias } from "../src/identity/selector.js";
import type { CallObservation, CallResult } from "../src/library/akuma-creation.js";
import type { DispatchStage, ForkResult } from "../src/index.js";
import { contractId } from "../src/core/facts/types.js";
import type { DebtRow } from "../src/debt/board.js";
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

function running(id: string, rows: readonly OpenSnapshotRow[]) {
  return akumaStatusSchema.parse({
    birth: DIRECT_BIRTH,
    id,
    life: "running",
    allowed: [],
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
    allowed: [],
    timeline: openAkumaSnapshot([{ kind: "row", row: note }], [reportedFileChange(1, "update", "/work/file")]),
  });
  const lines = snapshotText({ status, contract: { kind: "failed", diagnostic: "lookup refused" } }, DEFAULT_CONTEXT, {
    showAllowed: true,
  }).split("\n");
  assert.equal(lines[0], id, "identity roots the panel alone");
  assert.equal(lines[1], "  allowed  none", "effective actions are static context");
  assert.equal(lines[2], "  /work/appointed", "the execution directory is static context, not a labelled row");
  assert.equal(
    lines[3],
    frameRule([id, "  /work/appointed"], DEFAULT_CONTEXT.columns),
    "one rule divides context from activity",
  );
  assert.match(lines[4]!, /note +edited$/u);
  assert.match(lines[5]!, /^● running$/u);
  assert.ok(lines.indexOf("  changes 1") > 5, "reported changes follow the conclusion, subordinate");
  assert.ok(lines.some((line) => /^ {4}~ +\/work\/file$/u.test(line)));
  assert.equal(
    lines.filter((line) => line.includes("/work/appointed")).length,
    1,
    "no static coordinate is repeated below the timeline",
  );
  assert.ok(lines.indexOf("  ! contract failed lookup refused") > lines.indexOf("  changes 1"));
  assert.equal(lines.filter((line) => line.startsWith("!")).length, 0, "a diagnostic never becomes a bare static fact");
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
      text: "held input",
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
    "⧗ held input",
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

test("history keeps long call and Tell inputs to one bounded input line", () => {
  const text = "Final minimal correction ".repeat(12);
  const rows: ActivityRow[] = [
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
      kind: "history",
      id: parseAkuId("aku/elite/b9977141").id,
      contract: { kind: "none" },
      history: {
        rows,
        omitted: 0,
        hasEarlier: false,
        hasLater: false,
        historyLost: false,
        lowestRetained: 1,
        highest: 2,
      },
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
    allowed: [],
    timeline: idleAkumaSnapshot([{ kind: "row", row: pending }]),
  });
  assert.match(snapshotText({ status, contract: { kind: "none" } }, DEFAULT_CONTEXT), /⧗ follow up\n⧗ pending tell$/u);
});

test("Akuma observation failures name the target and reason without carrier words", () => {
  const first = parseAkuId("aku/worker/abcd0102").id;
  const second = parseAkuId("aku/intern/33dd4670").id;
  assert.equal(
    waitText(
      {
        mode: "all",
        reason: "deadline",
        observations: [],
        unobserved: [
          { id: first, diagnostic: "heart locked" },
          { id: second, diagnostic: "permission denied" },
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

function waitObservation(status: AkumaStatus) {
  return { status, contract: { kind: "none" as const }, createdDebts: { kind: "present" as const, rows: [] } };
}

function waitStatus(
  id: string,
  life: AkumaStatus["life"],
  timeline: AkumaStatus["timeline"],
  extra: { strandedReason?: "resume-unsupported" } = {},
): AkumaStatus {
  return akumaStatusSchema.parse({ birth: DIRECT_BIRTH, id, life, allowed: [], timeline, ...extra });
}

function failedOutcome(sequence: number, diagnostic: string): OutcomeRow {
  return {
    kind: "outcome",
    sequence,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    outcome: { kind: "failed", historyId: "history-1", diagnostic },
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
    { mode: "all", reason: "completed", observations: [waitObservation(status)], unobserved: [] },
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
    { mode: "all", reason: "completed", observations: members.map(waitObservation), unobserved: [] },
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
      mode: "all",
      reason: "completed",
      observations: [
        waitObservation(status),
        waitObservation(waitStatus("aku/worker/abcd0113", "asleep", idleAkumaSnapshot([]))),
      ],
      unobserved: [],
    },
    { alias: "@scout" },
    DEFAULT_CONTEXT,
  );
  assert.doesNotMatch(plural, /@scout/u, "an ambiguous alias is not attached to any member");
});

test("waited Tell reserves stdout for its exact answer and keeps one JSON envelope", () => {
  const id = parseAkuId("aku/worker/deadbeef").id;
  const result = {
    kind: "akuma" as const,
    action: "ask" as const,
    body: "continue",
    result: {
      akuma: id,
      tell: {
        admission: { fact: "recorded" as const, tellId: "tell-id" },
        row: {
          kind: "tell" as const,
          sequence: 1,
          at: AKUMA_ACTIVITY_AT,
          tellId: "tell-id",
          text: "continue",
          state: "told" as const,
          deliveries: [],
        },
        wake: { kind: "told" as const },
      },
      observation: { reason: "answered" as const, answer: "exact answer" },
    },
  };
  assert.equal(askRawAnswer(result.result, undefined), "exact answer");
  const context = { columns: 80, color: false };
  const ordinary = {
    kind: "akuma" as const,
    action: "tell" as const,
    body: result.body,
    result: { akuma: result.result.akuma, tell: result.result.tell },
  };
  const standalone = tellText(ordinary.result, undefined, context);
  assert.equal(standalone, "✓ told aku/worker/deadbeef — continue", "verdict, subject, and input on one line");
  const progress = waitedTellProgress(result.result, undefined, context);
  assert.match(progress, /▸ continue/u, "the panel keeps its timeline input row for admitted input");
  assert.equal(progress.match(/^aku\/worker\/deadbeef$/gmu)?.length, 1, "one identity frame");
  assert.equal(progress.match(/▸ continue/gu)?.length, 1, "the admission row is not replayed");
  assert.match(progress, /✓ answered\n\n$/u, "the progress conclusion separates stdout answer bytes");
  const long = {
    ...ordinary,
    result: {
      ...ordinary.result,
      tell: {
        ...ordinary.result.tell,
        row: {
          ...ordinary.result.tell.row,
          text: "one line of caller input ".repeat(20),
        },
      },
    },
  };
  const receipt = tellText(long.result, undefined, context).split("\n");
  assert.equal(receipt.length, 1, "one receipt line even past the terminal width");
  assert.match(receipt[0]!, /^✓ told aku\/worker\/deadbeef — one line of caller input .*…$/u);
  assert.doesNotMatch(
    receipt.join("\n"),
    /running|completed|pending tell|─|"$/u,
    "an action receipt has no frame and adds no quotes",
  );
  assert.ok(displayColumns(receipt[0]!) <= 80);
  assert.match(
    tellText({ ...long.result, tell: { ...long.result.tell, wake: { kind: "held" as const } } }, undefined, context),
    /^⧗ tell aku\/worker\/deadbeef — one line of caller input .*…$/u,
    "a held Tell keeps neutral vocabulary and the pending mark",
  );
  assert.equal(
    tellText(
      {
        ...ordinary.result,
        tell: { ...ordinary.result.tell, wake: { kind: "failed", diagnostic: "wake refused" } },
      },
      undefined,
      context,
    ),
    ["! tell aku/worker/deadbeef — continue", "  ! tell delivery failed · wake refused"].join("\n"),
    "an admitted Tell stays admitted and its failed wake keeps its own diagnosis",
  );
  assert.equal(killResultText(result.result.akuma, "killed"), `✓ killed ${result.result.akuma}`);
  assert.equal(
    killResultText(result.result.akuma, "unavailable", "@tired"),
    `! not killed ${result.result.akuma} (@tired)\n  unavailable`,
    "an untidy outcome keeps its native evidence",
  );
  assert.equal(result.result.tell.row.text, "continue", "timeline evidence still retains the Tell body");
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), result.result);

  const structured = {
    ...result,
    structured: true as const,
    result: { ...result.result, observation: { reason: "answered" as const, answer: "decoded scalar" } },
  };
  assert.equal(askRawAnswer(structured.result, true), '"decoded scalar"');
});

test("call and bounded Tell share one input frame and pinned conclusion", () => {
  const id = parseAkuId("aku/worker/deadbeef").id;
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
    kind: "observed",
    tell,
    observation: { reason: "answered", answer: "exact answer" },
    completedAt: AKUMA_ACTIVITY_AT,
  });

  const progress = askProgressStream(undefined, undefined, context);
  const admission = progress.admitted(tell, id);
  const tellFrame = progress.observe(liveObservation(status, [tell.row]));
  const tellConclusion = progress.conclude({
    akuma: id,
    tell,
    observation: { reason: "answered", answer: "exact answer" },
    completedAt: AKUMA_ACTIVITY_AT,
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
  assert.match(callConclusion, /✓ answered — 5s/u, "both adapters use the exact terminal completion time");
});

test("ask activity starts at admission and includes a later settlement of an older tool", () => {
  const id = parseAkuId("aku/worker/deadbeef").id;
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
      allowed: [],
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
  const conclusion = stream.conclude({ akuma: id, tell, observation: { reason: "answered", answer: "exact\nanswer" } });
  const transcript = [...admission, ...first, ...second, ...conclusion].join("\n");
  assert.equal((transcript.match(/new question/gu) ?? []).length, 1);
  assert.equal((transcript.match(/new activity/gu) ?? []).length, 1);
  assert.doesNotMatch(transcript, /original input|before ask|after ask/u);
  assert.equal(transcript.match(/old tool/gu)?.length, 1);
  assert.ok(transcript.indexOf("new question") < transcript.indexOf("new activity"));
  assert.match(transcript, /✓ answered\n\n$/u);
  assert.equal(
    askRawAnswer({ akuma: id, tell, observation: { reason: "answered", answer: "exact\nanswer" } }, undefined),
    "exact\nanswer",
  );
});

test("ask seed marks eligible omissions before a newer Turn opening in timeline order", () => {
  const id = parseAkuId("aku/worker/deadbeef").id;
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
      allowed: [],
      timeline: {
        ...openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))),
        turn: { kind: "turn" as const, sequence: 6, turnSequence: 2, bodySequence: 2, at },
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
    allowed: [],
    timeline: openAkumaSnapshot(
      [],
      [
        reportedFileChange(1, "update", "/work/unknown"),
        { ...reportedFileChange(2, "update", "/work/known"), diffstat: { added: 3, removed: 1 } },
      ],
    ),
  });
  const text = snapshotText({ status, contract: { kind: "none" } }, DEFAULT_CONTEXT);
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
const SPECIMEN_ID = parseAkuId("aku/worker/1234abcd").id;

function tellReceipt(
  text: string,
  state: "told" | "pending",
  wake: AkumaTellResult["tell"]["wake"],
): AkumaTellResult["tell"] {
  return {
    admission: { fact: "recorded", tellId: "tell/specimen" },
    row: { kind: "tell", sequence: 1, at: AKUMA_ACTIVITY_AT, tellId: "tell/specimen", text, state, deliveries: [] },
    wake,
  };
}

function called(
  observation: CallObservation,
  dispatch: CallResult["dispatch"] = { kind: "none" },
  alias: CallResult["alias"] = { kind: "none" },
): CallResult {
  return {
    kind: "called",
    akuma: SPECIMEN_ID,
    execution: { cwd: "/work/repo", source: "process" },
    dispatch,
    alias,
    observation,
  };
}

function dispatchOf(contract: string): DispatchStage {
  return {
    kind: "dispatched",
    dispatch: { akuId: SPECIMEN_ID, contractId: contractId(contract), dispatchedAt: AKUMA_ACTIVITY_AT },
  };
}

function forkReceipt(parent: string, child: string, dispatch: DispatchStage): ForkResult {
  return { kind: "forked", parent: parseAkuId(parent).id, child: parseAkuId(child).id, dispatch };
}

function createdDebtRow(): DebtRow {
  return {
    id: "debt/example" as DebtRow["id"],
    title: "close the rake",
    state: "open",
    priority: 2,
    disposition: "ready",
    updatedAt: AKUMA_ACTIVITY_AT,
    bodyPresent: false,
  };
}

test("Akuma outcomes distinguish admission from failed execution", () => {
  const tell = tellReceipt("go", "told", { kind: "told" });
  assert.equal(callOutcome(called({ kind: "born" })), "accepted");
  assert.equal(tellOutcome({ akuma: SPECIMEN_ID, tell }), "accepted");
  assert.equal(tellOutcome({ akuma: SPECIMEN_ID, tell: { ...tell, wake: { kind: "failed", diagnostic: "wake refused" } } }), "failed");
  const observation = { reason: "failed" as const, diagnostic: "provider stopped" };
  assert.equal(callOutcome(called({ kind: "observed", tell, observation })), "failed");
  assert.equal(askOutcome({ akuma: SPECIMEN_ID, tell, observation }), "failed");
  assert.equal(askOutcome({ akuma: SPECIMEN_ID, tell, observation: { reason: "invalid-output", diagnostic: "schema mismatch", answer: "wrong" } }), "failed");
});

test("every action receipt leads with a verdict and subject, then indented evidence", () => {
  const context = { columns: 100, color: false };
  assert.deepEqual(
    renderCallText(called({ kind: "born" }), false, context).split("\n"),
    ["✓ called aku/worker/1234abcd", "  /work/repo"],
    "a prompt-free birth is an action receipt with its directory subordinate",
  );
  assert.deepEqual(
    renderCallText(
      called({ kind: "detached", tell: tellReceipt("go", "told", { kind: "told" }) }, dispatchOf("kei/example-1234"), {
        kind: "aliased",
        alias: { alias: "@reviewer" as AkumaAlias, akuId: SPECIMEN_ID },
        previous: null,
      }),
      false,
      context,
    ).split("\n"),
    ["✓ called aku/worker/1234abcd (@reviewer)", "  kei/example-1234", "  /work/repo"],
    "the alias supplements the subject and distinct fact kinds stay on their own lines",
  );
  assert.deepEqual(
    renderCallText(
      called(
        { kind: "detached", tell: tellReceipt("go", "told", { kind: "told" }) },
        { kind: "failed", failure: { kind: "infrastructure", diagnostic: "busy" } },
        { kind: "skipped", reason: "dispatch-failed" },
      ),
      false,
      context,
    ).split("\n"),
    ["! called aku/worker/1234abcd", "  /work/repo", "  ! dispatch failed infrastructure busy"],
    "a failed stage marks the receipt instead of standing under an unqualified success",
  );
  assert.deepEqual(
    renderCallText(
      called({
        kind: "failed",
        tellId: "tell/specimen",
        failure: { kind: "infrastructure", diagnostic: "window lost" },
      }),
      false,
      context,
    ).split("\n"),
    ["! called aku/worker/1234abcd", "  /work/repo", "  ! window lost"],
    "a detached failure with no admitted Tell stays an action receipt over the born child",
  );
  assert.deepEqual(
    renderCallText(
      called({
        kind: "failed",
        tellId: "tell/specimen",
        tell: tellReceipt("exact prompt", "told", { kind: "told" }),
        failure: { kind: "infrastructure", diagnostic: "window lost" },
      }),
      false,
      context,
    ).split("\n"),
    ["! called aku/worker/1234abcd", "  /work/repo", '  "exact prompt"', "  ! window lost"],
    "an admitted Tell input stays visible beneath the failed call verdict",
  );
  assert.deepEqual(
    renderCallText(
      called(
        { kind: "detached", tell: tellReceipt("go", "told", { kind: "told" }) },
        {
          kind: "dispatched",
          dispatch: { akuId: SPECIMEN_ID, contractId: contractId("kei/example-1234"), dispatchedAt: AKUMA_ACTIVITY_AT },
          seatClose: [{ kind: "private-state-seat-close-failed", diagnostic: "seat closed late" }],
        },
      ),
      false,
      context,
    ).split("\n"),
    [
      "✓ called aku/worker/1234abcd",
      "  kei/example-1234",
      "  /work/repo",
      "  dispatch lag private-state-seat-close-failed seat closed late",
    ],
    "an admitted lag is evidence, not a failed verdict",
  );
  assert.deepEqual(
    renderForkText(forkReceipt("aku/worker/9999beef", "aku/worker/5678abcd", dispatchOf("kei/example-1234"))).split(
      "\n",
    ),
    ["✓ forked aku/worker/5678abcd", "  from aku/worker/9999beef", "  kei/example-1234"],
    "a fork states its source without inventing a Turn or a directory",
  );
  assert.deepEqual(
    renderForkText(
      forkReceipt("aku/worker/9999beef", "aku/worker/5678abcd", {
        kind: "failed",
        failure: { kind: "publication-failed", diagnostic: "read-only mirror" },
      }),
    ).split("\n"),
    [
      "! forked aku/worker/5678abcd",
      "  from aku/worker/9999beef",
      "  ! dispatch failed publication-failed read-only mirror",
    ],
    "a forked child with a failed association keeps both identities and the concrete cause",
  );
  assert.deepEqual(
    renderForkText({ kind: "provider-cannot-fork", provider: "acp-x", parent: SPECIMEN_ID }).split("\n"),
    ["! fork aku/worker/1234abcd", "  acp-x cannot fork"],
    "a fork that never happened keeps its reason beneath the marked verdict",
  );
});

test("Tell and kill keep pending, failure, and plural evidence inside the action hierarchy", () => {
  const context = { columns: 100, color: false };
  assert.deepEqual(
    tellText({ akuma: SPECIMEN_ID, tell: tellReceipt("go", "told", { kind: "told" }) }, undefined, context).split("\n"),
    ["✓ told aku/worker/1234abcd — go"],
    "the submitted payload appears once inline with its delivery verdict",
  );
  assert.equal(
    tellText({ akuma: SPECIMEN_ID, tell: tellReceipt("  go  ", "told", { kind: "told" }) }, "@tired", context),
    "✓ told aku/worker/1234abcd (@tired) — go",
    "whitespace folds, the alias stays a parenthetical supplement, and no quote is added",
  );
  assert.equal(
    tellText(
      { akuma: SPECIMEN_ID, tell: tellReceipt('  he said "wait"\n', "told", { kind: "told" }) },
      undefined,
      context,
    ),
    '✓ told aku/worker/1234abcd — he said "wait"',
    "literal source quotes survive and folding invents no others",
  );
  assert.equal(
    tellText({ akuma: SPECIMEN_ID, tell: tellReceipt("   ", "told", { kind: "told" }) }, undefined, context),
    "✓ told aku/worker/1234abcd",
    "an empty input adds no invented text or trailing separator",
  );
  const cramped = tellText({ akuma: SPECIMEN_ID, tell: tellReceipt("go", "told", { kind: "told" }) }, undefined, {
    columns: 12,
    color: false,
  });
  assert.equal(
    cramped,
    "✓ told aku/worker/1234abcd — …",
    "a verdict and identity wider than the terminal stay whole and the input keeps its visible ellipsis",
  );
  assert.deepEqual(
    tellText({ akuma: SPECIMEN_ID, tell: tellReceipt("go", "pending", { kind: "held" }) }, undefined, context).split(
      "\n",
    ),
    ["⧗ tell aku/worker/1234abcd — go"],
    "a held Tell keeps the pending mark and asserts no delivery",
  );
  assert.deepEqual(
    tellText(
      { akuma: SPECIMEN_ID, tell: tellReceipt("go", "told", { kind: "failed", diagnostic: "wake refused" }) },
      undefined,
      context,
    ).split("\n"),
    ["! tell aku/worker/1234abcd — go", "  ! tell delivery failed · wake refused"],
    "an admitted Tell stays admitted and its failed wake keeps its concrete cause",
  );
  assert.equal(
    renderKillText(
      {
        results: [
          { id: parseAkuId("aku/worker/1234abcd").id, evidence: "killed" },
          { id: parseAkuId("aku/worker/5678abcd").id, evidence: "already-stopped" },
          { id: parseAkuId("aku/worker/9999beef").id, evidence: "hung" },
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

test("created Debt observations use the shared dropped disposition", () => {
  const status = waitStatus("aku/worker/abcd1234", "asleep", idleAkumaSnapshot([]));
  const text = snapshotText({
    status,
    contract: { kind: "none" },
    createdDebts: { kind: "present", rows: [{ ...createdDebtRow(), state: "drop", disposition: "drop" }] },
  }, DEFAULT_CONTEXT);
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
    allowed: [],
    timeline: openAkumaSnapshot(
      [{ kind: "row", row: { kind: "note", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "edited" } }],
      [reportedFileChange(1, "update", "/work/file")],
    ),
  });
  const text = snapshotText(
    {
      status,
      contract: { kind: "associated", contractId: contractId("kei/example-1234") },
      createdDebts: { kind: "present", rows: [createdDebtRow()] },
    },
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
    ["  changes 1", "    ~  /work/file", "  debts 1", "    ○ debt/example · close the rake · ready · P2"],
    "dynamic outputs stay subordinate and no diagnostic is reported",
  );
  const failedContract = snapshotText({ status, contract: { kind: "failed", diagnostic: "lookup refused" } }, context);
  assert.equal(
    failedContract.split("\n").at(-1),
    "  ! contract failed lookup refused",
    "a lookup that failed is a subordinate diagnostic, not a free Contract",
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
    allowed: [],
    timeline: openAkumaSnapshot([
      {
        kind: "row",
        row: { kind: "said", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "👩‍💻".repeat(30) },
      },
    ]),
  });
  const lines = snapshotText(
    { status, contract: { kind: "associated", contractId: contractId("kei/narrow-columns") } },
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
  const failedObservation = (tell: AkumaTellResult["tell"]): CallObservation => ({
    kind: "failed",
    tellId: tell.admission.fact === "recorded" ? tell.admission.tellId : "tell/specimen",
    tell,
    failure: { kind: "infrastructure", diagnostic: "window lost" },
  });
  const stream = callObservationStream(context, { ...head, cwd: "/work/repo" });
  const lines = stream.conclude(failedObservation(tellReceipt("exact prompt", "told", { kind: "told" }))).split("\n");
  const headLines = [`${SPECIMEN_ID} (@scout) · kei/demo`, "  /work/repo"];
  assert.deepEqual(
    lines.slice(0, 3),
    [...headLines, frameRule(headLines, context.columns)],
    "the failure panel states the known directory above the boundary and fabricates nothing",
  );
  assert.match(lines[3]!, /^▸ exact prompt$/u, "the admitted input is the panel's first evidence");
  assert.equal(lines[4], "! window lost");

  // A Tell row that already settled on the timeline is that evidence; the close must not replay it.
  const observedStream = callObservationStream(context, head);
  const settled = observedStream.observe({
    status: running(SPECIMEN_ID, [tellReceipt("exact prompt", "told", { kind: "told" }).row]),
    rows: [tellReceipt("exact prompt", "told", { kind: "told" }).row],
  });
  const observedText = [
    ...settled,
    observedStream.conclude(failedObservation(tellReceipt("exact prompt", "told", { kind: "told" }))),
  ].join("\n");
  assert.equal((observedText.match(/exact prompt/gu) ?? []).length, 1, "a settled admission row is never replayed");
  assert.match(observedText, /! window lost\n*$/u);

  // An admission that never settled was never printed, so closing on it prints it once.
  const pending = tellReceipt("exact prompt", "pending", { kind: "held" });
  const pendingStream = callObservationStream(context, head);
  const pendingSettled = pendingStream.observe({
    status: running(SPECIMEN_ID, [pending.row]),
    rows: [pending.row],
  });
  const pendingText = [...pendingSettled, pendingStream.conclude(failedObservation(pending))].join("\n");
  assert.equal((pendingText.match(/exact prompt/gu) ?? []).length, 1);
  assert.match(pendingText, /⧗ exact prompt/u);
});
