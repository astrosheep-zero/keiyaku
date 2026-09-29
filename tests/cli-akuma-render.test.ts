import assert from "node:assert/strict";
import test from "node:test";
import { parseAkumaStatus, type ActivityRow, type AkumaStatus } from "../src/akuma/akuma.js";
import {
  activityStream,
  associatedIdentity,
  callObservationStream,
  DEFAULT_CONTEXT,
  frameRule,
  killResultText,
  snapshotActivityLines,
  snapshotHeading,
  snapshotText,
  tellText,
  waitObservationStream,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import {
  akumaRawAnswer,
  renderAkumaJson,
  renderAkumaText,
  askProgressStream,
  waitedTellProgress,
} from "../src/cli/render/akuma.js";
import { parseArgv } from "../src/cli/parse.js";
import { akumaMark } from "../src/cli/render/marks.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { displayColumns, padToDisplay } from "../src/cli/render/terminal.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import {
  activeTool,
  completedTool,
  idleAkumaSnapshot,
  openAkumaSnapshot,
  AKUMA_ACTIVITY_AT,
  reportedFileChange,
} from "./support/kanshi-activity.js";

function running(id: string, rows: readonly ActivityRow[]) {
  return parseAkumaStatus({
    id,
    life: "running",
    allowed: [],
    timeline: openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))),
  });
}

function settled(id: string, rows: readonly Extract<ActivityRow, { kind: "said" }>[]) {
  return parseAkumaStatus({
    id,
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))),
  });
}

function observed(status: AkumaStatus, rows: readonly ActivityRow[]) {
  return { status, rows, contract: { kind: "none" as const } };
}

test("status frame closes its timeline before references and ends at cwd", () => {
  const id = "aku/worker/abcd1234";
  const note: ActivityRow = { kind: "note", sequence: 1, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "edited" };
  const status = parseAkumaStatus({
    id,
    life: "running",
    cwd: "/work/appointed",
    allowed: [],
    timeline: openAkumaSnapshot([{ kind: "row", row: note }], [reportedFileChange(1, "update", "/work/file")]),
  });
  const lines = snapshotText({ status, contract: { kind: "failed", diagnostic: "lookup refused" } }, DEFAULT_CONTEXT, {
    showAllowed: true,
  }).split("\n");
  assert.equal(lines[0], id);
  assert.equal(lines[1], frameRule([id]));
  assert.match(lines[2]!, /note +edited$/u);
  assert.match(lines[3]!, /^\d{2}:\d{2} ● running$/u);
  assert.ok(lines.indexOf("changes 1") > 3);
  assert.ok(lines.some((line) => /^  ~ +\/work\/file$/u.test(line)));
  assert.ok(lines.indexOf("allowed  none") > lines.indexOf("changes 1"));
  assert.ok(lines.indexOf("! contract failed lookup refused") > lines.indexOf("changes 1"));
  assert.equal(lines.at(-1), "cwd  /work/appointed");
});

test("quoted activity hard-wraps once, aligns continuations and truncates at a grapheme boundary", () => {
  const row: ActivityRow = {
    kind: "said",
    sequence: 1,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "👩‍💻".repeat(45),
  };
  const lines = snapshotActivityLines(openAkumaSnapshot([{ kind: "row", row }]), { columns: 40, color: false });
  assert.equal(lines.length, 2);
  assert.equal((lines.join("\n").match(/“/gu) ?? []).length, 1);
  assert.equal((lines.join("\n").match(/”/gu) ?? []).length, 1);
  assert.match(lines[1]!, /^ {5} │ {8}👩‍💻/u);
  assert.match(lines[1]!, /…”$/u);
  for (const line of lines) assert.ok(displayColumns(line) <= 40);
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
  const status = parseAkumaStatus({
    id: "aku/worker/abcd1234",
    life: "asleep",
    allowed: [],
    timeline: idleAkumaSnapshot([{ kind: "row", row: pending }]),
  });
  assert.match(
    snapshotText({ status, contract: { kind: "none" } }, DEFAULT_CONTEXT),
    /⧗ tell +“follow up”\n\d{2}:\d{2} ⧗ pending tell$/u,
  );
});

test("Akuma observation failures name the target and reason without carrier words", () => {
  const first = parseAkuId("aku/worker/abcd0102").id;
  const second = parseAkuId("aku/intern/33dd4670").id;
  assert.equal(
    waitText(
      {
        kind: "akuma",
        action: "wait",
        result: {
          mode: "all",
          reason: "deadline",
          observations: [],
          unobserved: [
            { id: first, diagnostic: "heart locked" },
            { id: second, diagnostic: "permission denied" },
          ],
        },
      },
      DEFAULT_CONTEXT,
    ),
    [
      `× Akuma observation failed  ${first} — heart locked`,
      `× Akuma observation failed  ${second} — permission denied`,
    ].join("\n"),
  );
});

test("waited Tell reserves stdout for its exact answer and keeps one JSON envelope", () => {
  const result = {
    kind: "akuma" as const,
    action: "ask" as const,
    body: "continue",
    result: {
      akuma: "aku/worker/deadbeef",
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
  assert.equal(akumaRawAnswer(result), "exact answer");
  const context = { columns: 80, color: false };
  const ordinary = {
    kind: "akuma" as const,
    action: "tell" as const,
    body: result.body,
    result: { akuma: result.result.akuma, tell: result.result.tell },
  };
  assert.match(tellText(ordinary, context), /✓ told +"continue"/u);
  const progress = waitedTellProgress(result.result, undefined, context);
  assert.match(progress, /✓ told +"continue"/u);
  assert.equal(progress.match(/^aku\/worker\/deadbeef$/gmu)?.length, 1, "one identity frame");
  assert.equal(progress.match(/✓ told +"continue"/gu)?.length, 1, "the admission row is not replayed");
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
  const receipt = tellText(long, context).split("\n");
  assert.equal(receipt.length, 3, "frame head, rule and one Tell row only");
  assert.equal(receipt[1], frameRule([result.result.akuma]));
  assert.match(receipt[2]!, /✓ told +"one line of caller input .*…"$/u);
  assert.doesNotMatch(receipt.join("\n"), /running|completed|pending tell/u);
  assert.ok(displayColumns(receipt[2]!) <= 80);
  assert.match(
    tellText(
      { ...long, result: { ...long.result, tell: { ...long.result.tell, wake: { kind: "held" as const } } } },
      context,
    ),
    /⧗ tell/u,
  );
  assert.match(
    tellText(
      {
        ...ordinary,
        result: {
          ...ordinary.result,
          tell: { ...ordinary.result.tell, wake: { kind: "failed", diagnostic: "wake refused" } },
        },
      },
      context,
    ),
    /^\d{2}:\d{2} ! tell +"continue"\n! tell delivery failed · wake refused$/mu,
  );
  assert.equal(
    killResultText(result.result.akuma, "killed"),
    `${result.result.akuma}\n${frameRule([result.result.akuma])}\n\n✓ killed`,
  );
  assert.equal(result.result.tell.row.text, "continue", "timeline evidence still retains the Tell body");
  assert.deepEqual(JSON.parse(renderAkumaJson(result)), result.result);

  const structured = {
    ...result,
    structured: true as const,
    result: { ...result.result, observation: { reason: "answered" as const, answer: "decoded scalar" } },
  };
  assert.equal(akumaRawAnswer(structured), '"decoded scalar"');
  const command = parseArgv(["ask", result.result.akuma, "--wait", "1s", "continue"]);
  assert.equal("command" in command, true);
  assert.equal(renderAkumaText(command as never, structured, context), '"decoded scalar"');
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
  const tellFrame = progress.observe({ status, rows: [tell.row] });
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
  assert.equal(tellTranscript.match(/told +"continue"/gu)?.length, 1);
  assert.ok(tellTranscript.indexOf("told") > tellTranscript.indexOf(`${id}\n`));
  assert.equal(tellTranscript.split(id).length - 1, 1, "the transcript contains exactly one identity frame");
  assert.equal(callTranscript.match(/told +“continue”/gu)?.length, 1);
  assert.ok(callTranscript.indexOf("told") > callTranscript.indexOf(`${id}\n`));
  assert.equal(callTranscript.split(id).length - 1, 1, "the call transcript contains exactly one identity frame");
  assert.equal(tellFrame.length, 0, "the admitted Tell receipt is not replayed by observation");
  assert.equal(tellConclusion.length, 1);
  assert.equal(tellConclusion[0], callConclusion);
  assert.match(callConclusion, /✓ answered — 5s/u, "both adapters use the exact terminal completion time");
});

test("ask activity starts at admission and includes a later settlement of an older tool", () => {
  const id = parseAkuId("aku/worker/deadbeef").id;
  const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
  const opening: ActivityRow = { kind: "call", sequence: 1, turnSequence: 1, at: at(0), text: "original input" };
  const oldNote: ActivityRow = { kind: "note", sequence: 2, turnSequence: 1, at: at(1), text: "before ask" };
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
  const later: ActivityRow = { kind: "note", sequence: 5, turnSequence: 1, at: at(4), text: "after ask" };
  const next: ActivityRow = { kind: "note", sequence: 6, turnSequence: 1, at: at(5), text: "new activity" };
  const oldSettled = { ...completedTool(7, "bash", { kind: "run" as const, command: "old tool" }), at: at(6) };
  const status = (rows: readonly ActivityRow[]) =>
    parseAkumaStatus({
      id,
      life: "running",
      allowed: [],
      timeline: { ...openAkumaSnapshot(rows.map((row) => ({ kind: "row" as const, row }))), openingSequence: 1 },
    });
  const stream = askProgressStream(undefined, undefined, { columns: 100, color: false });
  const admission = stream.admitted(tell, id);
  assert.match(admission.join("\n"), /✓ told +"new question"/u, "the receipt is returned before observation");
  const firstRows = [opening, oldNote, oldActive, tell.row, later];
  const first = stream.observe({ status: status(firstRows), rows: firstRows });
  assert.deepEqual(first, ["      ⋮ 1 omitted"], "only post-admission settled evidence counts as omitted");
  const secondRows = [opening, oldNote, tell.row, later, next, oldSettled];
  const second = stream.observe({ status: status(secondRows), rows: secondRows });
  assert.match(second.join("\n"), /new activity/u);
  assert.match(second.join("\n"), /old tool/u);
  assert.deepEqual(stream.observe({ status: status(secondRows), rows: secondRows }), [], "later activity streams once");
  const conclusion = stream.conclude({ akuma: id, tell, observation: { reason: "answered", answer: "exact\nanswer" } });
  const transcript = [...admission, ...first, ...second, ...conclusion].join("\n");
  assert.equal((transcript.match(/new question/gu) ?? []).length, 1);
  assert.equal((transcript.match(/new activity/gu) ?? []).length, 1);
  assert.doesNotMatch(transcript, /original input|before ask|after ask/u);
  assert.equal(transcript.match(/old tool/gu)?.length, 1);
  assert.ok(transcript.indexOf("new question") < transcript.indexOf("new activity"));
  assert.match(transcript, /✓ answered\n\n$/u);
  assert.equal(
    akumaRawAnswer({
      kind: "akuma",
      action: "ask",
      body: "new question",
      result: { akuma: id, tell, observation: { reason: "answered", answer: "exact\nanswer" } },
    }),
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
  const earlier: ActivityRow = { kind: "note", sequence: 2, turnSequence: 1, at, text: "earlier" };
  const beforeOpening: ActivityRow = { kind: "note", sequence: 5, turnSequence: 1, at, text: "eligible but skipped" };
  const opening: ActivityRow = { kind: "call", sequence: 6, turnSequence: 2, at, text: "next turn" };
  const afterOpening: ActivityRow = { kind: "note", sequence: 7, turnSequence: 2, at, text: "also skipped" };
  const live: ActivityRow = { kind: "note", sequence: 8, turnSequence: 2, at, text: "live update" };
  const status = (rows: readonly ActivityRow[]) =>
    parseAkumaStatus({
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
  const baseline = stream.observe({ status: status(rows), rows });
  assert.equal(baseline.length, 3);
  assert.match(baseline[0]!, /⋮ 1 omitted/u);
  assert.match(baseline[1]!, /call +next turn/u);
  assert.match(baseline[2]!, /⋮ 1 omitted/u);
  const later = stream.observe({ status: status([...rows, live]), rows: [...rows, live] });
  assert.match(later.join("\n"), /live update/u);
  assert.deepEqual(stream.observe({ status: status([...rows, live]), rows: [...rows, live] }), []);
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
  for (const [life, mark] of Object.entries(expected)) assert.equal(akumaMark(life as never), mark, life);
});

test("plural wait tags selected identities and keeps rows compact at 80 columns", () => {
  const first = "aku/worker/deadbeef";
  const second = "aku/worker/facefeed";
  const firstBase = activeTool(1, "bash", { kind: "run", command: "open" });
  const secondBase = activeTool(1, "bash", { kind: "run", command: "other-open" });
  const stream = waitObservationStream({ columns: 80, color: false }, { now: () => 0 });
  stream.select([
    { id: first, alias: parseAkumaAlias("@first") },
    { id: second, alias: parseAkumaAlias("@second") },
  ]);
  const opening = stream.observe([
    observed(running(first, [firstBase]), [firstBase]),
    observed(running(second, [secondBase]), [secondBase]),
  ]);
  assert.deepEqual(opening.slice(0, 2), ["dead @first", "face @second"]);
  assert.equal(opening.at(-1), "─".repeat(Math.max(displayColumns("dead @first"), displayColumns("face @second"))));

  const longSay: ActivityRow = {
    kind: "said",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "a long streamed answer ".repeat(8),
  };
  const sameMinuteNote: ActivityRow = {
    kind: "note",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "same minute",
  };
  const rows = stream.observe([
    observed(running(first, [firstBase, longSay]), [firstBase, longSay]),
    observed(running(second, [secondBase, sameMinuteNote]), [secondBase, sameMinuteNote]),
  ]);
  assert.equal(rows.length, 1, "live rows stay in the redrawable frame");
  const frame = stream.frame();
  const liveSayIndex = frame.findIndex((row) => row.includes(" say    "));
  assert.match(frame[liveSayIndex]!, /^\s*dead ● say    “/u);
  assert.equal(frame[liveSayIndex + 1]!.endsWith("…"), true, "an in-flight say uses two lines and stays open");
  assert.match(frame[liveSayIndex + 1]!, /^\s+│\s+\S/u, "the continuation aligns under the speech body");
  assert.equal((frame.join("\n").match(/“/gu) ?? []).length, 1);
  assert.equal((frame.join("\n").match(/”/gu) ?? []).length, 0);
  assert.match(
    rows[0]!,
    /^\d{2}:\d{2} face │ note   same minute$/u,
    "the stream-global minute keeps its blank time column",
  );
  for (const row of rows) assert.ok(displayColumns(row) <= 80, row);
});

test("plural wait falls back to a distinguishing identity suffix for equal final segments", () => {
  const first = "aku/one/deadbeef";
  const second = "aku/two/deadbeef";
  const firstBase = activeTool(1, "bash", { kind: "run", command: "open" });
  const secondBase = activeTool(1, "bash", { kind: "run", command: "other-open" });
  const stream = waitObservationStream({ columns: 80, color: false }, { now: () => 0 });
  stream.select([
    { id: first, alias: parseAkumaAlias("@first") },
    { id: second, alias: parseAkumaAlias("@second") },
  ]);
  const opening = stream.observe([
    observed(running(first, [firstBase]), [firstBase]),
    observed(running(second, [secondBase]), [secondBase]),
  ]);
  assert.deepEqual(opening.slice(0, 2), ["one/deadbeef @first", "two/deadbeef @second"]);

  const firstNote: ActivityRow = { kind: "note", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "first" };
  const secondNote: ActivityRow = { kind: "note", sequence: 2, turnSequence: 1, at: AKUMA_ACTIVITY_AT, text: "second" };
  const rows = stream.observe([
    observed(running(first, [firstBase, firstNote]), [firstBase, firstNote]),
    observed(running(second, [secondBase, secondNote]), [secondBase, secondNote]),
  ]);
  assert.match(rows[0]!, /^\d{2}:\d{2} one\/deadbeef │ note   first$/u);
  assert.match(rows[1]!, /^      two\/deadbeef │ note   second$/u);
});

test("an open turn settles old says on the rail and only its trailing say flushes unresolved", () => {
  const oldSay: ActivityRow = {
    kind: "said",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "old settled say",
  };
  const tools = [3, 4, 5, 6].map((sequence) =>
    completedTool(sequence, "bash", { kind: "run", command: `after-say-${sequence}` }),
  );
  const trailingSay: ActivityRow = {
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
    settled.some((line) => line.includes("old settled say") && line.includes("│")),
    "a say with a successor settles on the rail",
  );
  assert.ok(!settled.some((line) => line.includes("?")), "a settled say never prints as unresolved");
  const live = stream.frame();
  assert.ok(!live.some((line) => line.includes("old settled say")), "a settled say never enters the live frame");
  const liveSay = live.find((line) => line.includes(" say    "))!;
  assert.match(liveSay, /● say/u, "only the open turn's trailing say stays live");
  assert.ok(liveSay.includes("still streaming"), "the trailing say's text is live");
  assert.ok(!liveSay.includes("”"), "the trailing say's quote remains open");
  const flushed = stream.flush();
  assert.ok(
    flushed.some((line) => line.includes("still streaming") && line.includes("?")),
    "only the trailing say flushes unresolved",
  );
  assert.ok(!flushed.some((line) => line.includes("old settled say")), "a settled say is never flushed");
  assert.ok(!flushed.some((line) => line.includes("after-say-6")), "an in-flight final say omits prior tail tools");
  assert.ok(flushed.some((line) => line.includes("⋮ 1 omitted")), "the earlier tool stays accounted for");
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

test("plural wait closes settled said rows but leaves in-flight said rows open", () => {
  const first = "aku/worker/deadbeef";
  const second = "aku/worker/facefeed";
  const firstBase = activeTool(1, "bash", { kind: "run", command: "open" });
  const secondBase = activeTool(1, "bash", { kind: "run", command: "other-open" });
  const stream = waitObservationStream({ columns: 80, color: false }, { now: () => 0 });
  stream.select([{ id: first }, { id: second }]);
  stream.observe([
    observed(running(first, [firstBase]), [firstBase]),
    observed(running(second, [secondBase]), [secondBase]),
  ]);

  const inFlight: Extract<ActivityRow, { kind: "said" }> = {
    kind: "said",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "in-flight ".repeat(30),
  };
  const complete: Extract<ActivityRow, { kind: "said" }> = {
    kind: "said",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "settled ".repeat(30),
  };
  const rows = stream.observe([
    observed(running(first, [firstBase, inFlight]), [firstBase, inFlight]),
    observed(settled(second, [complete]), [complete]),
  ]);
  const frame = stream.frame();
  const liveSayIndex = frame.findIndex((row) => row.includes(" say    "));
  assert.match(frame[liveSayIndex]!, /^\s*dead ● say    “/u);
  assert.equal(frame[liveSayIndex + 1]!.endsWith("…"), true, "an in-flight say uses two lines without closing");
  assert.match(rows[0]!, /^\d{2}:\d{2} face │ say    “/u);
  assert.equal(rows.length, 2, "a settled say uses its two-line budget");
  assert.equal(rows[1]!.endsWith("…”"), true, "a settled say closes its quote after truncation");
  for (const row of rows) assert.ok(displayColumns(row) <= 80, row);
});

test("plural wait attributes omitted spans and the scoreboard by identity tag", () => {
  const first = "aku/worker/deadbeef";
  const second = "aku/worker/facefeed";
  const firstBase = activeTool(1, "bash", { kind: "run", command: "open" });
  const secondBase = activeTool(1, "bash", { kind: "run", command: "other-open" });
  const stream = waitObservationStream({ columns: 80, color: false }, { now: () => 0 });
  stream.select([{ id: first }, { id: second }]);
  stream.observe([
    observed(running(first, [firstBase]), [firstBase]),
    observed(running(second, [secondBase]), [secondBase]),
  ]);
  const tools = Array.from({ length: 9 }, (_, index) =>
    completedTool(index + 2, "bash", { kind: "run", command: `tool-${index + 1}` }),
  );
  stream.observe([
    observed(running(first, [firstBase, ...tools]), [firstBase, ...tools]),
    observed(running(second, [secondBase]), [secondBase]),
  ]);
  const conclusion = stream.conclude({
    reason: "deadline",
    observations: [
      {
        status: running(first, [firstBase, ...tools]),
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
      {
        status: running(second, [secondBase]),
        contract: { kind: "none" as const },
        createdTasks: { kind: "present" as const, rows: [] },
      },
    ],
    unobserved: [],
  });
  assert.match(conclusion, /^      dead ⋮ 4 omitted$/mu);
  assert.match(conclusion, /^\d{2}:\d{2} dead ● running/mu);
  assert.match(conclusion, /^\d{2}:\d{2} face ● running/mu);
});

test("changes section renders unknown diffstat as ~ and known as +a -r", () => {
  const status = parseAkumaStatus({
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
    text.split("\n").some((line) => /^  ~ +\/work\/unknown$/u.test(line)),
    text,
  );
  assert.ok(
    text.split("\n").some((line) => /^  \+3 -1 +\/work\/known$/u.test(line)),
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
