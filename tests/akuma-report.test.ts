import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Akuma, type AkumaReportResult } from "../src/index.js";
import { HeldAkumaLeash, activitySlice, beginTurn, breakBody, endTurn, readHeart, recordReport } from "../src/akuma/heart/index.js";
import { insertActivityFact } from "../src/akuma/heart/rows.js";
import { withHeartTransaction } from "../src/akuma/heart/storage.js";
import { pruneActivityFacts } from "../src/akuma/heart/timeline.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { parseArgv } from "../src/cli/parse.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { bornBody, allocatedHeart, claudeBodyLaunch } from "./support/akuma-fixtures.js";
import { fixtureAdapter } from "./support/akuma-tell.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { temporaryDirectory } from "./support/process.js";

const AT = "2026-10-30T00:00:00.000Z";

async function reportFixture(root: string, suffix: string, initiator?: string) {
  const world = await World.at(root);
  const born = await bornBody(root, suffix, AT);
  const turn = await beginTurn(born.allocated.paths, {
    bodySequence: born.body.sequence, startedAt: AT,
    ...(initiator === undefined ? {} : { initiator }),
  });
  // Own the whole plugin selection rather than inheriting machine user settings.
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  await pluginRuntime({ world, settings: await settings({ root: world, home: join(root, "empty-home") }) });
  return { ...born, world, turn, execution: { bodySequence: born.body.sequence, turnSequence: turn.sequence } };
}

test("a driven Body supplies exact execution to a real reporting CLI child before its final answer", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-driven-");
  const world = await World.at(root);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const allocated = await allocatedHeart(root, "claude", "feed0007");
  const cli = fileURLToPath(new URL(`../src/cli/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));
  const adapter = fixtureAdapter(async input => {
    assert.ok(input.execution, "Body must freeze its exact admitted context before provider work");
    const environment = akumaExecutionEnvironment(process.env, {}, input.requests.dir, [], input.execution);
    const child = await promisify(execFile)(process.execPath, [
      ...(import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
      cli, "report", "milestone from actual child", "--json",
    ], { cwd: root, env: environment });
    const recorded = JSON.parse(child.stdout) as AkumaReportResult;
    assert.equal(recorded.kind, "recorded");
    return {
      events: { async *[Symbol.asyncIterator]() {
        yield { type: "session" as const, coordinate: { sessionId: "report-child-native" } };
      } },
      completion: Promise.resolve({ kind: "answered" as const, answer: "final, not the report" }),
    };
  });
  await driveAkumaBody(claudeBodyLaunch(allocated, root, "work"), adapter, { world });
  const akuma = Akuma.select(world, allocated.id);
  assert.equal((await akuma.status()).life, "asleep");
  const history = await akuma.history();
  const report = history.rows.find(row => row.kind === "report");
  assert.equal(report?.text, "milestone from actual child");
  const outcome = history.rows.at(-1);
  assert.equal(outcome?.kind, "outcome");
  if (outcome?.kind !== "outcome" || outcome.outcome.kind !== "answered") assert.fail("expected final answer");
  assert.equal(outcome.outcome.answer, "final, not the report");
});

test("native report is a distinct durable history/stream row and does not complete work", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-native-");
  const value = await reportFixture(root, "feed0001", "opening-owner");
  const akuma = Akuma.select(value.world, value.allocated.id);
  try {
    const stream = akuma.stream()[Symbol.asyncIterator]();
    try {
      await stream.next();
      const text = "first milestone\n  exact whitespace\n";
      const recorded = await akuma.report(text, value.execution);
      assert.equal(recorded.kind, "recorded");
      if (recorded.kind !== "recorded") assert.fail("report refused");
      const history = await akuma.history();
      assert.deepEqual(history.rows.filter(row => row.kind === "report"), [recorded.report]);
      assert.equal(history.rows.some(row => row.kind === "outcome"), false);
      const changed = await stream.next();
      assert.equal(changed.done, false);
      assert.deepEqual(changed.value?.rows.filter(row => row.kind === "report"), [recorded.report]);
      const status = await akuma.status();
      assert.equal(status.life, "running");
      assert.equal(status.timeline.kind, "open");
      const idle = await akuma.idle({ timeoutMs: 0 });
      assert.equal(idle.reason, "deadline");
      await endTurn(value.allocated.paths, {
        turnSequence: value.turn.sequence, completedAt: AT,
        outcome: { kind: "answered", answer: "the final answer", session: { sessionId: "native" } },
      });
      const final = await akuma.history();
      assert.equal(final.rows.at(-1)?.kind, "outcome");
      assert.deepEqual(final.rows.filter(row => row.kind === "report"), [recorded.report]);
    } finally { await stream.return?.(); }
  } finally { value.holder.release(); }
});

test("report admission refuses absent and stale Body/Turn without writes, including same-Body succession", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-fence-");
  const value = await reportFixture(root, "feed0002");
  const input = { ...value.execution, text: "stale", at: AT };
  const absent = await allocateAkumaDirectory({ worldRoot: value.world, archetype: "claude", draw: () => "feedffff" });
  assert.deepEqual(await recordReport(absent.paths, input), { kind: "refused", reason: "not-born" });
  try {
    const before = await activitySlice(value.allocated.paths);
    assert.deepEqual(await recordReport(value.allocated.paths, { ...input, bodySequence: value.body.sequence + 1 }),
      { kind: "refused", reason: "not-current-execution" });
    assert.deepEqual(await activitySlice(value.allocated.paths), before);
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    const nextTurn = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    const next = await activitySlice(value.allocated.paths);
    assert.deepEqual(await recordReport(value.allocated.paths, input), { kind: "refused", reason: "not-current-execution" });
    assert.deepEqual(await activitySlice(value.allocated.paths), next);
    await breakBody(value.allocated.paths, { sequence: value.body.sequence, end: "put-down", at: AT });
    value.holder.release();
    const successorHolder = (await HeldAkumaLeash.try(value.allocated.paths))!;
    try {
      const nextBody = await successorHolder.recordBody(value.allocated.paths, { leashTakenAt: AT });
      await beginTurn(value.allocated.paths, { bodySequence: nextBody.sequence, startedAt: AT });
      const successor = await activitySlice(value.allocated.paths);
      assert.deepEqual(await recordReport(value.allocated.paths, { ...input, turnSequence: nextTurn.sequence }),
        { kind: "refused", reason: "not-current-execution" });
      assert.deepEqual(await activitySlice(value.allocated.paths), successor);
    } finally { successorHolder.release(); }
  } finally { value.holder.release(); }
});

test("reports use the existing retention sequence and do not acquire a second history store", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-retention-");
  const value = await reportFixture(root, "feed0003");
  const akuma = Akuma.select(value.world, value.allocated.id);
  try {
    const old = await akuma.report("old", value.execution);
    assert.equal(old.kind, "recorded");
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    const current = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    await withHeartTransaction(value.allocated.paths, database => {
      for (let i = 0; i < 5_600; i++) insertActivityFact(database, {
        turnSequence: current.sequence, event: { type: "note", text: `detail ${i}` }, at: AT,
      });
      pruneActivityFacts(database, 5_000);
    });
    const latest = await akuma.report("retained", { bodySequence: value.body.sequence, turnSequence: current.sequence });
    assert.equal(latest.kind, "recorded");
    if (latest.kind !== "recorded" || old.kind !== "recorded") assert.fail("report refused");
    const retained = await activitySlice(value.allocated.paths);
    assert.equal(retained.rows.some(row => row.sequence === old.report.sequence), false);
    assert.deepEqual(retained.rows.filter(row => row.kind === "report"), [latest.report]);
    const history = await akuma.history({ since: old.report.sequence, limit: 2 });
    assert.equal(history.historyLost, true);
    assert.ok(history.rows.every(row => row.sequence > old.report.sequence));
    assert.equal((await readHeart(value.allocated.paths)).latestBody?.end, undefined);
  } finally { value.holder.release(); }
});

test("post-commit signal carries exact report and opening ownership; handler failure cannot undo it", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-signal-");
  const world = await World.at(root);
  const value = await bornBody(root, "feed0004", AT);
  const trace = join(root, "signals.jsonl");
  const plugin = join(root, "observer.mjs");
  writeFileSync(plugin, `import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export default { manifest: { id: 'report-test', apiVersion: 1 }, activate() {
  return { signals: { 'akuma.reported'(signal) {
    const heart = new DatabaseSync(${JSON.stringify(value.allocated.paths.heart)}, { readOnly: true });
    try {
      const report = heart.prepare('SELECT text FROM reports WHERE sequence = ?').get(signal.reportSequence);
      if (report?.text !== signal.text) throw new Error('report must already be committed');
    } finally { heart.close(); }
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify(signal) + '\\n');
    throw new Error('notification deliberately failed');
  } } };
} };`);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {
    "report-test": { package: "./observer.mjs" },
  } }));
  await pluginRuntime({ world, settings: await settings({ root: world, home: join(root, "empty-home") }) });
  const diagnostics: string[] = [];
  const akuma = Akuma.select(world, value.allocated.id, { reportDiagnostic: message => diagnostics.push(message) });
  try {
    const turn = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT, initiator: "Alice" });
    const recorded = await akuma.report("exact\nreport", { bodySequence: value.body.sequence, turnSequence: turn.sequence });
    if (recorded.kind !== "recorded") assert.fail("report refused");
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8").trim()), {
      kind: "akuma.reported", akumaId: value.allocated.id, bodySequence: value.body.sequence,
      turnSequence: turn.sequence, reportSequence: recorded.report.sequence, text: recorded.report.text,
      at: recorded.report.at, initiator: "Alice",
    });
    assert.ok(diagnostics.some(message => message.includes("notification deliberately failed")));
    assert.deepEqual((await akuma.history()).rows.filter(row => row.kind === "report"), [recorded.report]);
    await endTurn(value.allocated.paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    const next = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    const unattributed = await akuma.report("without recipient", { bodySequence: value.body.sequence, turnSequence: next.sequence });
    assert.equal(unattributed.kind, "recorded");
    const signals = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    assert.equal(signals.length, 2, "one attempt per committed report; reads do not replay");
    assert.equal(Object.hasOwn(signals[1]!, "initiator"), false, "a new Turn cannot inherit the earlier owner");
  } finally { value.holder.release(); }
});

test("retained report corruption fails observation instead of becoming a partial or fabricated row", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-corrupt-");
  const value = await reportFixture(root, "feed0006");
  const akuma = Akuma.select(value.world, value.allocated.id);
  try {
    assert.equal((await akuma.report("valid", value.execution)).kind, "recorded");
    await withHeartTransaction(value.allocated.paths, database => {
      database.prepare("UPDATE reports SET at = 'not a timestamp'").run();
    });
    await assert.rejects(akuma.history(), /expected report timestamp/u);
  } finally { value.holder.release(); }
});

test("CLI report adapts explicit immutable execution, takes stdin, and never resolves parent transport", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-cli-");
  const value = await reportFixture(root, "feed0005");
  const environment = akumaExecutionEnvironment({}, {}, "/missing-parent-channel", [], {
    akumaId: value.allocated.id, world: value.world, ...value.execution,
  });
  try {
    const result = await cliJson<AkumaReportResult>(["report", "-"], {
      cwd: root, environment, readStdin: async () => "report from stdin\n",
    });
    assert.equal(result.exit, 0);
    assert.equal(result.value.kind, "recorded");
    if (result.value.kind !== "recorded") assert.fail("report refused");
    assert.equal(result.value.report.text, "report from stdin\n");
    await assert.rejects(runCli(["report", "cannot guess"], { cwd: root, environment: { KEIYAKU_EXTERNAL_CALLER: "pi:host" } }),
      /requires explicit KEIYAKU_ACTOR_ID/u);
    const noTurn = { ...environment };
    delete noTurn.KEIYAKU_TURN_SEQUENCE;
    await assert.rejects(runCli(["report", "no latest-Turn fallback"], { cwd: root, environment: noTurn }),
      /KEIYAKU_TURN_SEQUENCE/u);
    assert.throws(() => parseArgv(["report", "recipient", "text"]), /one text argument/u);
    assert.throws(() => parseArgv(["report", "text", "-"]), /one text argument/u);
    const akuma = Akuma.select(value.world, value.allocated.id);
    assert.equal((await akuma.history()).rows.filter(row => row.kind === "report").length, 1);
    // A retained native runtime (currently Paseo) keeps this creation environment.
    // Its normal successor executes, but that old process cannot report as the new Turn.
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    const resumed = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    const stale = await cliJson<AkumaReportResult>(["report", "old native context"], { cwd: root, environment });
    assert.notEqual(stale.exit, 0);
    assert.deepEqual(stale.value, { kind: "refused", reason: "not-current-execution" });
    assert.equal((await akuma.status()).timeline.kind, "open", "report refusal must not break resumed execution");
    assert.equal((await akuma.history()).rows.filter(row => row.kind === "report").length, 1);
    const fresh = await akuma.report("explicit fresh context", { bodySequence: value.body.sequence, turnSequence: resumed.sequence });
    assert.equal(fresh.kind, "recorded");
    const successorEnvironment = akumaExecutionEnvironment(environment);
    assert.equal(successorEnvironment.KEIYAKU_BODY_SEQUENCE, undefined);
    assert.equal(successorEnvironment.KEIYAKU_TURN_SEQUENCE, undefined);
  } finally { value.holder.release(); }
});
