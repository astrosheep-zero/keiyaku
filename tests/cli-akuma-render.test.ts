import assert from "node:assert/strict";
import test from "node:test";
import { parseAkumaStatus, type ActivityRow, type AkumaStatus } from "../src/akuma/akuma.js";
import { akumaMark } from "../src/cli/render/kanshi-akuma.js";
import {
  associatedIdentity,
  DEFAULT_CONTEXT,
  frameRule,
  mutationObservationStageText,
  snapshotHeading,
  waitObservationStream,
  waitText,
} from "../src/cli/render/akuma-activity.js";
import { parseAkuId } from "../src/akuma/identity.js";
import { displayColumns } from "../src/cli/render/terminal.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import {
  activeTool,
  completedTool,
  idleAkumaSnapshot,
  openAkumaSnapshot,
  AKUMA_ACTIVITY_AT,
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

test("Akuma observation failures name the target and reason without carrier words", () => {
  const first = parseAkuId("aku/worker/abcd0102").id;
  const second = parseAkuId("aku/intern/33dd4670").id;
  assert.equal(
    mutationObservationStageText(first, { kind: "unobserved", diagnostic: "heart locked" }, DEFAULT_CONTEXT),
    `× Akuma observation failed  ${first} — heart locked`,
  );
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

test("Akuma presentation uses the settled six-mark vocabulary", () => {
  assert.equal(akumaMark("killed"), "×");
  assert.equal(akumaMark("running"), "●");
  assert.equal(akumaMark("asleep"), "○");
  assert.equal(akumaMark("stranded"), "!");
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
  assert.match(conclusion, /^\d{2}:\d{2} dead ● still running/mu);
  assert.match(conclusion, /^\d{2}:\d{2} face ● still running/mu);
});
