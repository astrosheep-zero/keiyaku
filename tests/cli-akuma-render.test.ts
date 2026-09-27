import assert from "node:assert/strict";
import test from "node:test";
import { parseAkumaStatus, type ActivityRow, type AkumaStatus } from "../src/akuma/akuma.js";
import {
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
import { displayColumns } from "../src/cli/render/terminal.js";
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
  const lines = snapshotText(
    { status, contract: { kind: "failed", diagnostic: "lookup refused" } },
    DEFAULT_CONTEXT,
    { showAllowed: true },
  ).split("\n");
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
  assert.match(lines[1]!, /^ {15}👩‍💻/u);
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
      { ...ordinary, result: { ...ordinary.result, tell: { ...ordinary.result.tell, wake: { kind: "failed", diagnostic: "wake refused" } } } },
      context,
    ),
    /^\d{2}:\d{2} ! tell +"continue"\n! tell delivery failed · wake refused$/mu,
  );
  assert.equal(killResultText(result.result.akuma, "killed"), `${result.result.akuma}\n${frameRule([result.result.akuma])}\n\n✓ killed`);
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
  const call = callObservationStream(
    context,
    { id, contract: { kind: "none" }, facts: [] },
    { now: () => startedAt },
  );
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
  assert.equal(rows.length, 2, "plural activity rows never wrap");
  assert.match(rows[0]!, /^\d{2}:\d{2} dead ⧖ say    "/u);
  assert.equal(rows[0]!.endsWith("…"), true, "an in-flight say ends in one trailing ellipsis");
  assert.equal((rows[0]!.match(/"/gu) ?? []).length, 1, "the in-flight quote remains open");
  assert.match(rows[1]!, /^      face │ note   same minute$/u, "the stream-global minute keeps its blank time column");
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
    text: "in-flight ".repeat(12),
  };
  const complete: Extract<ActivityRow, { kind: "said" }> = {
    kind: "said",
    sequence: 2,
    turnSequence: 1,
    at: AKUMA_ACTIVITY_AT,
    text: "settled ".repeat(12),
  };
  const rows = stream.observe([
    observed(running(first, [firstBase, inFlight]), [firstBase, inFlight]),
    observed(settled(second, [complete]), [complete]),
  ]);
  assert.match(rows[0]!, /^\d{2}:\d{2} dead ⧖ say    "/u);
  assert.equal(rows[0]!.endsWith("…"), true, "an in-flight say has no closing quote");
  assert.match(rows[1]!, /^      face │ say    "/u);
  assert.equal(rows[1]!.endsWith('…"'), true, "a settled say closes its quote after truncation");
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
