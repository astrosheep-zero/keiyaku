import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Akuma, Akumas, type AkumaReportResult } from "../src/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { activitySlice, beginTurn, breakBody, endTurn, readHeart, recordReport } from "../src/akuma/heart/index.js";
import { insertActivityFact } from "../src/akuma/heart/rows.js";
import { withHeartTransaction } from "../src/akuma/heart/storage.js";
import { pruneActivityFacts } from "../src/akuma/heart/timeline.js";
import { allocateAkumaDirectory, parsePublicHistoryId } from "../src/akuma/identity.js";
import { akumaExecutionEnvironment } from "../src/akuma/providers/execution-environment.js";
import { parseArgv } from "../src/cli/parse.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { bornBody, bornDirectAkuma, allocatedHeart, claudeBodyLaunch, noBodyLaunch } from "./support/akuma-fixtures.js";
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
    const environment = akumaExecutionEnvironment(process.env, {}, [], input.execution);
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
  await driveAkumaBody(claudeBodyLaunch(allocated, root, "work"), adapter, {
    world, spawn: noBodyLaunch,
  });
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
      const recorded = await akuma.report(text);
      assert.equal(recorded.kind, "recorded");
      if (recorded.kind !== "recorded") assert.fail("report refused");
      const history = await akuma.history();
      const report = history.rows.find(row => row.kind === "report");
      assert.ok(report?.kind === "report");
      assert.deepEqual(recorded, { kind: "recorded", reportId: `report/${report.sequence}` });
      assert.deepEqual(report, { kind: "report", sequence: report.sequence, bodySequence: value.body.sequence,
        turnSequence: value.turn.sequence, at: report.at, text });
      assert.equal(history.rows.some(row => row.kind === "outcome"), false);
      const changed = await stream.next();
      assert.equal(changed.done, false);
      assert.deepEqual(changed.value?.rows.filter(row => row.kind === "report"), [report]);
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
      assert.deepEqual(final.rows.filter(row => row.kind === "report"), [report]);
    } finally { await stream.return?.(); }
  } finally { value.holder.release(); }
});

test("exact report history selects retained identity without observing outcomes", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-exact-");
  const value = await reportFixture(root, "feed0008");
  const akuma = Akuma.select(value.world, value.allocated.id);
  const observed: string[] = [];
  const owner = new AkumaOwner(value.allocated.id, value.world, async (_id, ids) => { observed.push(...ids); });
  try {
    const first = await akuma.report("first");
    const second = await akuma.report(" second\n  complete\n");
    if (first.kind !== "recorded" || second.kind !== "recorded") assert.fail("report refused");
    const id = second.reportId;
    const reports = (await akuma.history()).rows.filter(row => row.kind === "report");
    const firstReport = reports.find(row => `report/${row.sequence}` === first.reportId)!;
    const secondReport = reports.find(row => `report/${row.sequence}` === second.reportId)!;
    assert.equal(secondReport.text, " second\n  complete\n");
    assert.equal(parsePublicHistoryId(id), null);
    assert.deepEqual(await owner.fork({ at: id }, noBodyLaunch), { kind: "unknown-history" });
    assert.deepEqual(await owner.history({ id }), { kind: "exact-report", report: secondReport });
    assert.deepEqual(await owner.history({ id: first.reportId }), { kind: "exact-report", report: firstReport });
    assert.deepEqual(await owner.history({ id: `report/${value.turn.sequence}` }), { kind: "unknown-history", id: `report/${value.turn.sequence}` });
    const composed = await Akumas.of(value.world).history({ akuma: value.allocated.id, id });
    assert.equal(composed.kind, "akuma-report");
    if (composed.kind === "akuma-report") {
      const { kind: _kind, ...row } = secondReport;
      assert.deepEqual(composed, { kind: "akuma-report", akumaId: value.allocated.id, ...row });
    }
    const text = await runCli(["history", value.allocated.id, "--id", id], { cwd: root });
    assert.equal(text.exit, 0);
    assert.equal(text.stdout, secondReport.text);
    const json = await cliJson<typeof composed>(["history", value.allocated.id, "--id", id], { cwd: root });
    assert.deepEqual(json.value, composed);
    const missing = await runCli(["history", value.allocated.id, "--id", "report/999999"], { cwd: root });
    assert.notEqual(missing.exit, 0);
    for (const invalid of ["report/0", "report/01", "report/9007199254740992", "report/-1"]) {
      assert.throws(() => parseArgv(["history", value.allocated.id, "--id", invalid]));
      await assert.rejects(owner.history({ id: invalid }), TypeError);
    }
    for (const flag of ["--last", "--before", "--since", "--limit"]) {
      assert.throws(() => parseArgv(["history", value.allocated.id, "--id", id, flag, ...(flag === "--last" ? [] : ["1"])]));
    }
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT,
      outcome: { kind: "answered", answer: "final", session: { sessionId: "native" } } });
    assert.deepEqual(await owner.history({ id }), { kind: "exact-report", report: secondReport });
    assert.deepEqual(observed, []);
    const exact = await owner.history({ id: `turn/${value.turn.sequence}` });
    assert.ok("kind" in exact && exact.kind === "exact");
    assert.deepEqual(observed, [`turn/${value.turn.sequence}`]);
    const last = await Akumas.of(value.world).history({ akuma: value.allocated.id, last: true });
    assert.equal(last.kind, "akuma-last");
    if (last.kind === "akuma-last") assert.equal(last.answer, "final");
  } finally { value.holder.release(); }
});

test("report admission selects current execution and refuses closed execution", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-admission-");
  const value = await reportFixture(root, "feed0002");
  const input = { text: "progress", at: AT };
  const absent = await allocateAkumaDirectory({ worldRoot: value.world, akumaName: "claude", draw: () => "feedffff" });
  assert.deepEqual(await recordReport(absent.paths, input), { kind: "refused", reason: "not-born" });
  try {
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    assert.deepEqual(await recordReport(value.allocated.paths, input), { kind: "refused", reason: "not-executing" });
    const next = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    const result = await recordReport(value.allocated.paths, input);
    assert.equal(result.kind, "recorded");
    if (result.kind === "recorded") assert.equal(result.report.turnSequence, next.sequence);
    await breakBody(value.allocated.paths, { sequence: value.body.sequence, end: "put-down", at: AT });
    assert.deepEqual(await recordReport(value.allocated.paths, input), { kind: "refused", reason: "not-executing" });
    await assert.rejects(Akuma.select(value.world, value.allocated.id).report("bad", { bodySequence: 1 } as never), /unknown field/u);
  } finally { value.holder.release(); }
});

test("report refuses a born Akuma without a Body, Turn, or non-hung execution", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-inactive-");
  const world = await World.at(root);
  const born = await bornDirectAkuma({ root: world, akumaName: "claude", draw: "feed0010", createdAt: AT });
  const input = { text: "progress", at: AT };
  try {
    assert.deepEqual(await recordReport(born.paths, input), { kind: "refused", reason: "not-executing" });
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: AT });
    assert.deepEqual(await recordReport(born.paths, input), { kind: "refused", reason: "not-executing" });
    await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: AT });
    await born.leash.recordBodyHung(born.paths, { sequence: body.sequence, diagnostic: "custody live", at: AT });
    assert.deepEqual(await recordReport(born.paths, input), { kind: "refused", reason: "not-executing" });
    const result = await cliJson<AkumaReportResult>(["report", "progress"], {
      cwd: root, environment: { KEIYAKU_ACTOR_ID: born.id, KEIYAKU_ACTOR_WORLD: world },
    });
    assert.equal(result.exit, 1);
    assert.deepEqual(result.value, { kind: "refused", reason: "not-executing" });
  } finally { born.leash.release(); }
});

test("reports use the existing retention sequence and do not acquire a second history store", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-retention-");
  const value = await reportFixture(root, "feed0003");
  const akuma = Akuma.select(value.world, value.allocated.id);
  try {
    const old = await akuma.report("old");
    assert.equal(old.kind, "recorded");
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    const current = await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    await withHeartTransaction(value.allocated.paths, database => {
      for (let i = 0; i < 5_600; i++) insertActivityFact(database, {
        turnSequence: current.sequence, event: { type: "note", text: `detail ${i}` }, at: AT,
      });
      pruneActivityFacts(database, 5_000);
    });
    const latest = await akuma.report("retained", {});
    assert.equal(latest.kind, "recorded");
    if (latest.kind !== "recorded" || old.kind !== "recorded") assert.fail("report refused");
    const retained = await activitySlice(value.allocated.paths);
    assert.equal(retained.rows.some(row => `report/${row.sequence}` === old.reportId), false);
    const owner = new AkumaOwner(value.allocated.id, value.world);
    const id = old.reportId;
    assert.deepEqual(await owner.history({ id }), { kind: "unknown-history", id });
    const report = retained.rows.find(row => `report/${row.sequence}` === latest.reportId);
    assert.ok(report?.kind === "report");
    assert.equal(report.text, "retained");
    const oldSequence = Number(old.reportId.slice("report/".length));
    const history = await akuma.history({ since: oldSequence, limit: 2 });
    assert.equal(history.historyLost, true);
    assert.ok(history.rows.every(row => row.sequence > oldSequence));
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
    const recorded = await akuma.report("exact\nreport", {});
    if (recorded.kind !== "recorded") assert.fail("report refused");
    const report = (await akuma.history()).rows.find(row => row.kind === "report");
    assert.ok(report?.kind === "report");
    assert.equal(recorded.reportId, `report/${report.sequence}`);
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8").trim()), {
      kind: "akuma.reported", akumaId: value.allocated.id, bodySequence: value.body.sequence,
      turnSequence: turn.sequence, reportSequence: report.sequence, text: "exact\nreport",
      at: report.at, initiator: "Alice",
    });
    assert.ok(diagnostics.some(message => message.includes("notification deliberately failed")));
    assert.deepEqual((await akuma.history()).rows.filter(row => row.kind === "report"), [report]);
    await endTurn(value.allocated.paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    const unattributed = await akuma.report("without recipient", {});
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
    assert.equal((await akuma.report("valid")).kind, "recorded");
    await withHeartTransaction(value.allocated.paths, database => {
      database.prepare("UPDATE reports SET at = 'not a timestamp'").run();
    });
    await assert.rejects(akuma.history(), /expected report timestamp/u);
  } finally { value.holder.release(); }
});

test("CLI report adapts explicit immutable execution and takes stdin", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-report-cli-");
  const value = await reportFixture(root, "feed0005");
  const environment = akumaExecutionEnvironment({}, {}, [], {
    akumaId: value.allocated.id, world: value.world,
  });
  try {
    const result = await cliJson<AkumaReportResult>(["report", "-"], {
      cwd: root, environment, readStdin: async () => "report from stdin\n",
    });
    assert.equal(result.exit, 0);
    assert.equal(result.value.kind, "recorded");
    if (result.value.kind !== "recorded") assert.fail("report refused");
    const reports = (await Akuma.select(value.world, value.allocated.id).history()).rows.filter(row => row.kind === "report");
    assert.equal(reports[0]?.text, "report from stdin\n");
    assert.deepEqual(result.value, { kind: "recorded", reportId: `report/${reports[0]!.sequence}` });
    await assert.rejects(runCli(["report", "cannot guess"], { cwd: root, environment: { KEIYAKU_EXTERNAL_CALLER: "pi:host" } }),
      /requires explicit KEIYAKU_ACTOR_ID/u);
    assert.throws(() => parseArgv(["report", "recipient", "text"]), /one text argument/u);
    const akuma = Akuma.select(value.world, value.allocated.id);
    await endTurn(value.allocated.paths, { turnSequence: value.turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });
    await beginTurn(value.allocated.paths, { bodySequence: value.body.sequence, startedAt: AT });
    const text = await runCli(["report", "resumed"], { cwd: root, environment });
    assert.equal(text.exit, 0);
    assert.match(text.stdout.trimEnd(), new RegExp(`^recorded ${value.allocated.id} report/\\d+$`));
    assert.equal((await akuma.history()).rows.filter(row => row.kind === "report").length, 2);
  } finally { value.holder.release(); }
});
