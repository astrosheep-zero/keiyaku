import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { fixtureAdapter } from "./support/akuma-tell.js";
import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import {
  activityFact,
  bornBody,
  bornLineageAkuma,
  claudeBodyLaunch,
  seedLegacySchema,
  turnEndFact,
} from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { waitForFixtureFile as waitForFile } from "./support/process.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { AkumaNotBornError } from "../src/akuma/akuma-errors.js";
import type { AkumaCaller } from "../src/akuma/caller.js";
import { killAkumaWithRecovery } from "../src/akuma/akuma-owner.js";
import {
  projectTurns,
  selectHistory,
  selectSnapshot,
  activitySnapshotSchema,
  type ActivitySnapshot,
  type ActivityHistory,
  type TurnLedger,
} from "../src/akuma/projection.js";
import { loadPreparedArchetype } from "../src/akuma/archetype.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { driveAkumaBody, tellWakeRuntime } from "../src/akuma/body.js";
import { spawnAkumaBody } from "../src/akuma/detached-body.js";
import type { BodyLaunch, BodyLauncher, LiveBodyLaunch } from "../src/akuma/body-launch.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import {
  activitySlice,
  appendActivity,
  beginTurn,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  HeldAkumaLeash,
  initializeHeart,
  probeLeash,
  readHeart,
  recordTell,
  recordTellDeliveries,
  type TimelineFact,
} from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, parseAkumaId, pathsForAkumaId } from "../src/akuma/identity.js";
import { recordAkumaLineage } from "../src/akuma/lineage-cache.js";
import { createProviderAttempt, type ProviderAdapter, type ToolCall } from "../src/akuma/provider.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { settings } from "../src/settings.js";
import { AkumaArchetypeError, Akumas, listArchetypeDefinitions } from "../src/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { projectCurrentWork } from "../src/akuma/status-projection.js";
import { World, type WorldRoot } from "../src/world.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { withHeartTransaction } from "../src/akuma/heart/storage.js";
import { insertBodyFact } from "../src/akuma/heart/rows.js";

const CLAUDE_EXECUTION = { name: "claude", kind: "claude-agent-sdk" } as const;

type DeferredBodyEnd = Readonly<{
  started: string;
  release: string;
  settled: string;
  turnStarted: string;
  turnRelease: string;
  turnSettled: string;
}>;

function configureDeferredBodyEndPlugin(root: string): DeferredBodyEnd {
  const plugins = join(root, "plugins");
  const started = join(root, "body-ended-started");
  const release = join(root, "body-ended-release");
  const settled = join(root, "body-ended-settled");
  const turnStarted = join(root, "turn-outcome-started");
  const turnRelease = join(root, "turn-outcome-release");
  const turnSettled = join(root, "turn-outcome-settled");
  const ledger = join(root, "square-ledger", "delivery.sqlite");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(
    join(plugins, "square-wrapper.mjs"),
    [
      `import square from ${JSON.stringify(pathToFileURL(resolve(process.cwd(), "plugins/square/index.js")).href)};`,
      'import { appendFileSync, existsSync } from "node:fs";',
      "async function waitForRelease(path) {",
      "  if (existsSync(path)) return;",
      "  const deadline = Date.now() + 60000;",
      "  while (!existsSync(path)) {",
      "    if (Date.now() >= deadline) throw new Error(`fixture wait for ${path} expired after 60000ms`);",
      "    await new Promise((resolve) => setImmediate(resolve));",
      "  }",
      "}",
      "export default {",
      '  manifest: { id: "square", apiVersion: 1, writablePaths: [{ name: "square", path: ".square" }] },',
      "  async activate(context) {",
      "    const previous = process.env.SQUARE_DELIVERY;",
      "    process.env.SQUARE_DELIVERY = context.config.ledger;",
      "    let actual;",
      "    try { actual = await square.activate(context); } finally {",
      "      if (previous === undefined) delete process.env.SQUARE_DELIVERY; else process.env.SQUARE_DELIVERY = previous;",
      "    }",
      '    const handler = actual.signals?.["akuma.turn-outcome"];',
      '    if (handler === undefined) throw new Error("Square plugin has no turn-outcome handler");',
      '    return { signals: { ...(actual.signals ?? {}), "akuma.turn-outcome": async (signal) => { appendFileSync(context.config.turnStarted, "turn-outcome\\n"); await waitForRelease(context.config.turnRelease); try { await handler(signal); } finally { appendFileSync(context.config.turnSettled, "turn-outcome\\n"); } } } };',
      "  },",
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(plugins, "deferred.mjs"),
    [
      'import { appendFileSync, existsSync } from "node:fs";',
      "async function waitForRelease(path) {",
      "  if (existsSync(path)) return Promise.resolve();",
      "  const deadline = Date.now() + 60000;",
      "  while (!existsSync(path)) {",
      "    if (Date.now() >= deadline) throw new Error(`fixture wait for ${path} expired after 60000ms`);",
      "    await new Promise((resolve) => setImmediate(resolve));",
      "  }",
      "}",
      "export default {",
      '  manifest: { id: "deferred", apiVersion: 1 },',
      '  activate(context) { return { signals: { "akuma.body-ended": async () => { appendFileSync(context.config.started, "started\\n"); try { await waitForRelease(context.config.release); } finally { appendFileSync(context.config.settled, "settled\\n"); } } } }; },',
      "};",
    ].join("\n"),
  );
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        square: {
          package: "./plugins/square-wrapper.mjs",
          config: {
            turnStarted,
            turnRelease,
            turnSettled,
            ledger,
          },
        },
        deferred: { package: "./plugins/deferred.mjs", config: { started, release, settled } },
      },
    }),
  );
  return { started, release, settled, turnStarted, turnRelease, turnSettled };
}

function historyPage(page: Awaited<ReturnType<AkumaOwner["history"]>>): ActivityHistory {
  if ("rows" in page) return page;
  throw new Error(`expected history page, received ${page.kind}`);
}

async function timeline(paths: Parameters<typeof activitySlice>[0]) {
  return (await activitySlice(paths)).rows;
}

async function bornHistoryHandle(root: string, suffix: string) {
  const { allocated, holder, body } = await bornBody(root, suffix, "2026-08-10T00:00:00.000Z");
  const turn = await beginTurn(allocated.paths, {
    bodySequence: body.sequence,
    startedAt: "2026-08-10T00:00:01.000Z",
  });
  return { allocated, holder, turn, handle: new AkumaOwner(allocated.id, await World.at(root)) };
}

function toolRow(rows: readonly { kind: string; sequence: number; state?: unknown }[]) {
  return rows.filter((row) => row.kind === "tool");
}

test("malformed public history IDs refuse before Heart reads", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-history-id-");
  const born = await bornHistoryHandle(root, "c0000005");
  born.holder.release();
  unlinkSync(born.allocated.paths.heart);
  for (const id of ["history-1", "0", "-1", "01", "+1", "1.5", "1e2", "9007199254740992", "act/2"]) {
    await assert.rejects(() => born.handle.history({ id }), TypeError);
    await assert.rejects(async () => Akumas.of(await World.at(root)).history({ akuma: born.allocated.id, id }), TypeError);
  }
  await assert.rejects(
    async () =>
      Akumas.of(await World.at(root)).history({
        akuma: born.allocated.id,
        id: "turn/9007199254740992",
      }),
    /turn\/<positive safe integer>/u,
  );
});

test("compact activity ids recover retained input, displaced tools and folded narration through CLI", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-activity-exact-");
  const world = await World.at(root);
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const born = await bornBody(root, "c0000020", "2026-08-10T00:00:00.000Z");
  const api = Akumas.of(world);
  const owner = new AkumaOwner(born.allocated.id, world);
  const command = `npm test ${"argument ".repeat(60)}`;
  const call = `begin ${"task ".repeat(100)}end`;
  try {
    const turn = await beginTurn(born.allocated.paths, { bodySequence: born.body.sequence, startedAt: "2026-08-10T00:00:01.000Z", call });
    const start = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-08-10T00:00:02.000Z",
      event: { type: "tool", phase: "started", id: "native-run", name: "bash", call: { kind: "run", command } },
    });
    const observed = await cliJson<Awaited<ReturnType<typeof api.status>>>(["status", born.allocated.id], { cwd: root });
    const active = observed.value.work.summary;
    assert.ok(active && active.id === start && active.clipped);
    const rawStart = await runCli(["history", born.allocated.id, "--id", String(active.id)], { cwd: root });
    assert.equal(rawStart.exit, 0);
    assert.equal(rawStart.stdout, `active: run $ ${command.trim()}`);
    const callEntry = (await owner.status()).timeline.entries.find(entry => entry.kind === "row" && entry.row.kind === "call");
    assert.ok(callEntry?.kind === "row");
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(callEntry.row.sequence)], { cwd: root })).stdout, `call: ${call}`);

    const done = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-08-10T00:00:03.000Z",
      event: { type: "tool", phase: "completed", id: "native-run", name: "bash", call: { kind: "run", command }, result: { status: "error", exitCode: 7, output: "retained output", message: "test failed" } },
    });
    const displaced = await api.history({ akuma: born.allocated.id, id: String(active.id) });
    assert.ok(displaced.kind === "akuma" && displaced.events[0]?.kind === "tool");
    if (displaced.kind !== "akuma" || displaced.events[0]?.kind !== "tool") assert.fail("missing retained start");
    assert.equal(displaced.events[0].sequence, start);
    assert.equal(displaced.events[0].state, "unsettled");
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(start)], { cwd: root })).stdout, `unknown: run $ ${command.trim()}`);
    const settled = await cliJson<Awaited<ReturnType<typeof api.history>>>(["history", born.allocated.id, "--id", String(done)], { cwd: root });
    assert.ok(settled.value.kind === "akuma" && settled.value.events[0]?.kind === "tool");
    if (settled.value.kind !== "akuma" || settled.value.events[0]?.kind !== "tool") assert.fail("missing completion");
    assert.equal(settled.value.events[0].durationMs, 1000);
    assert.deepEqual(settled.value.events[0].state, { status: "error", exitCode: 7, output: "retained output", message: "test failed" });
    assert.ok((await runCli(["history", born.allocated.id, "--id", String(done)], { cwd: root })).stdout.includes(command.trim()));

    const tellText = `continue\n  ${"direction ".repeat(50)}`;
    const admitted = await recordTell(born.allocated.paths, { kind: "tell", id: "exact-pending", body: tellText, recordedAt: "2026-08-10T00:00:04.000Z" });
    assert.equal(admitted.kind, "recorded");
    const pending = (await api.status({ akuma: born.allocated.id })).work.pending?.[0];
    assert.ok(pending);
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(pending.id)], { cwd: root })).stdout, `pending-tell: ${tellText}`);
    await recordTellDeliveries(born.allocated.paths, [{ tellId: "exact-pending", turnSequence: turn.sequence, route: "launch", fence: "native-fence", deliveredAt: "2026-08-10T00:00:05.000Z" }]);
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(pending.id)], { cwd: root })).stdout, `tell: ${tellText}`);

    const answer = `first\n  ${"answer 🙂 ".repeat(80)}last`;
    const said = await appendActivity(born.allocated.paths, { turnSequence: turn.sequence, at: "2026-08-10T00:00:06.000Z", event: { type: "assistant", text: answer } });
    const preview = (await api.status({ akuma: born.allocated.id })).work.summary;
    assert.ok(preview?.id === said && preview.text.startsWith("first ") && preview.clipped);
    await endTurn(born.allocated.paths, { turnSequence: turn.sequence, completedAt: "2026-08-10T00:00:07.000Z", outcome: { kind: "answered", answer, session: { sessionId: "exact-native" } } });
    assert.equal(historyPage(await owner.history()).rows.some(row => row.sequence === said), false);
    const rawSaid = await runCli(["history", born.allocated.id, "--id", String(said)], { cwd: root });
    assert.equal(rawSaid.stdout, `said: ${answer}`);
    assert.equal((await runCli(["history", born.allocated.id, "--last"], { cwd: root })).stdout, answer);
    assert.equal((await runCli(["history", born.allocated.id, "--id", `turn/${turn.sequence}`], { cwd: root })).stdout, answer);
    assert.deepEqual(await owner.fork({ at: String(said) }, noBodyLaunch), { kind: "unknown-history" });
    assert.equal((await api.history({ akuma: born.allocated.id, id: String(turn.sequence) })).kind, "akuma-unknown-history");
    assert.equal((await api.history({ akuma: born.allocated.id, id: "999999" })).kind, "akuma-unknown-history");
    const idle = await recordTell(born.allocated.paths, { kind: "tell", id: "idle-pending", body: tellText, recordedAt: "2026-08-10T00:00:08.000Z" });
    assert.equal(idle.kind, "recorded");
    const idleStatus = await api.status({ akuma: born.allocated.id });
    const idlePending = idleStatus.work.pending?.[0];
    assert.ok(idlePending && idleStatus.work.kind === "idle" && idleStatus.work.outcome?.verdict === "answered");
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(idlePending.id)], { cwd: root })).stdout, `pending-tell: ${tellText}`);
    assert.deepEqual(projectCurrentWork((await owner.status()).timeline), idleStatus.work);
  } finally { born.holder.release(); }
});

test("history moves a tool from its active start to its witnessed completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-history-remint-"));
  const born = await bornHistoryHandle(root, "c0000001");
  try {
    const start = await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool",
        phase: "started",
        id: "bash-1",
        name: "Bash",
        call: { kind: "run", command: "npm test" },
      },
      at: "2026-08-10T00:00:02.000Z",
    });
    const active = historyPage(await born.handle.history());
    const activeTool = active.rows.find((row) => row.kind === "tool");
    assert.ok(activeTool?.kind === "tool");
    assert.equal(activeTool.toolId, "bash-1");
    assert.equal(activeTool.turnSequence, born.turn.sequence);
    assert.deepEqual(
      toolRow(active.rows).map((row) => row.sequence),
      [start],
    );
    const done = await appendActivity(born.allocated.paths, {
      turnSequence: born.turn.sequence,
      event: {
        type: "tool",
        phase: "completed",
        id: "bash-1",
        name: "Bash",
        call: { kind: "run", command: "npm test" },
        result: { status: "ok" },
      },
      at: "2026-08-10T00:00:03.000Z",
    });
    assert.deepEqual([born.turn.sequence, start, done], [1, 2, 3]);

    const page = historyPage(await born.handle.history());
    const tools = toolRow(page.rows);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.sequence, done);
    const completed = page.rows.find((row) => row.kind === "tool");
    assert.ok(completed?.kind === "tool" && completed.state !== "active" && completed.state !== "unsettled");
    assert.equal(completed.at, "2026-08-10T00:00:03.000Z");
    assert.equal(completed.durationMs, 1_000);
    assert.equal(completed.toolId, activeTool.toolId);
    assert.equal(completed.turnSequence, activeTool.turnSequence);
    assert.equal(tools[0] !== undefined && "state" in tools[0] && tools[0].state !== "active", true);
    assert.equal(
      page.rows.some((row) => row.kind === "tool" && row.sequence === start),
      false,
    );

    const sinceStart = historyPage(await born.handle.history({ since: 2 }));
    assert.deepEqual(
      toolRow(sinceStart.rows).map((row) => row.sequence),
      [done],
    );
    assert.equal(
      sinceStart.rows.some((row) => row.sequence === start),
      false,
    );

    const beforeDone = historyPage(await born.handle.history({ before: done }));
    assert.deepEqual(
      toolRow(beforeDone.rows).map((row) => row.sequence),
      [],
    );
    assert.deepEqual(
      toolRow(historyPage(await born.handle.history()).rows).map((row) => row.sequence),
      [done],
    );
  } finally {
    born.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlapping file tools order each Turn and reported changes by completion", () => {
  const at = (minute: number) => `2026-08-10T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const file = (path: string): ToolCall => ({
    kind: "fileChange",
    changes: [
      {
        op: "update",
        path,
        diffstat: { added: 1, removed: 0 },
        patch: [`@@ -1 +1 @@`, `-${path}`, `+${path}`].join("\n"),
      },
    ],
  });
  const event = (sequence: number, phase: "started" | "completed", id: string, path: string) =>
    activityFact(
      sequence,
      1,
      at(sequence),
      phase === "completed"
        ? {
            type: "tool",
            phase: "completed",
            id,
            name: "edit",
            call: file(path),
            result: { status: "ok" as const, output: `${path} applied` },
          }
        : { type: "tool", phase: "started", id, name: "edit", call: file(path) },
    );
  const facts: readonly TimelineFact[] = [
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: at(0) },
    event(2, "started", "a", "src/a.ts"),
    event(3, "started", "b", "src/b.ts"),
    event(4, "completed", "b", "src/b.ts"),
    activityFact(5, 1, at(5), { type: "note", text: "between completions" }),
    event(6, "completed", "a", "src/a.ts"),
  ];
  const ledger = projectTurns(facts);
  assert.deepEqual(
    ledger.openTurn?.rows.map((row) => row.sequence),
    [4, 5, 6],
  );
  assert.deepEqual(
    ledger.rows.map((row) => row.sequence),
    [1, 4, 5, 6],
  );
  const view = selectSnapshot(ledger, { aperture: "monitoring" }).snapshot;
  assert.deepEqual(activitySnapshotSchema.parse(view), view, "public snapshot schema preserves tool identity");
  assert.deepEqual(
    ledger.rows.filter((row) => row.kind === "tool").map((row) => row.toolId),
    ["b", "a"],
  );
  assert.deepEqual(
    view.reportedChanges,
    [
      { path: "src/b.ts", diffstat: { added: 1, removed: 0 } },
      { path: "src/a.ts", diffstat: { added: 1, removed: 0 } },
    ],
    "reported changes stay a diffstat-only summary without observed content",
  );
  const published = activitySnapshotSchema.parse(view);
  assert.deepEqual(
    published.entries.flatMap((entry) =>
      entry.kind === "row" && entry.row.kind === "tool" ? [entry.row.sequence] : [],
    ),
    [4, 6],
    "the strict public snapshot admits rows carrying observed output and a patch",
  );
  const completedA = published.entries.find(
    (entry) => entry.kind === "row" && entry.row.kind === "tool" && entry.row.sequence === 6,
  );
  assert.ok(completedA?.kind === "row" && completedA.row.kind === "tool");
  assert.deepEqual(completedA.row.call, file("src/a.ts"));
  assert.deepEqual(completedA.row.state, { status: "ok", output: "src/a.ts applied" });
  const historyRow = selectHistory(ledger, { since: 4, limit: 20 }).rows.find(
    (row) => row.kind === "tool" && row.sequence === 6,
  );
  assert.ok(historyRow?.kind === "tool" && historyRow.state !== "active" && historyRow.state !== "unsettled");
  assert.deepEqual(historyRow.call, file("src/a.ts"));
  assert.deepEqual(historyRow.state, { status: "ok", output: "src/a.ts applied" });
  assert.deepEqual(
    selectHistory(ledger, { since: 4, limit: 20 }).rows.map((row) => row.sequence),
    [5, 6],
  );
  const pruned = projectTurns(facts.filter((fact) => fact.sequence !== 2));
  const completed = pruned.rows.find((row) => row.kind === "tool" && row.sequence === 6);
  assert.ok(completed?.kind === "tool" && completed.state !== "active" && completed.state !== "unsettled");
  assert.equal(completed.durationMs, undefined);
  assert.equal(completed.toolId, "a", "a completion without retained start keeps the producer identity");
  const closed = projectTurns([
    ...facts,
    event(7, "started", "unwitnessed", "src/open.ts"),
    turnEndFact(8, 1, at(8), { kind: "failed", diagnostic: "stopped" }),
  ]);
  const unsettled = closed.rows.find((row) => row.kind === "tool" && row.state === "unsettled");
  assert.ok(unsettled?.kind === "tool");
  assert.equal(unsettled.toolId, "unwitnessed");
});

test("forward history reports a pruned interval after its cursor", async () => {
  const history = selectHistory(
    projectTurns([activityFact(9, 1, "2026-08-08T00:00:09.000Z", { type: "note", text: "retained" })], {
      lowestRetained: 1,
      highest: 9,
    }),
    { since: 4, limit: 50 },
  );

  assert.equal(history.historyLost, true);
  assert.deepEqual(
    history.rows.map((row) => row.sequence),
    [9],
  );
});

for (const observation of ["status", "wait", "roster"] as const) {
  test(`${observation} observes a Body that finishes between Heart read and leash probe`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-observe-end-"));
    const value = await bornHistoryHandle(root, "f0000009");
    const originalTry = HeldAkumaLeash.try;
    const target = value.allocated.paths.leash.replace(/^\/private/u, "");
    let finished = false;
    const mockedTry = t.mock.method(HeldAkumaLeash, "try", async (paths: typeof value.allocated.paths) => {
      if (!finished && paths.leash.replace(/^\/private/u, "") === target) {
        finished = true;
        await endTurn(paths, {
          turnSequence: value.turn.sequence,
          outcome: { kind: "answered", answer: "finished", session: { sessionId: "observation-fixture" } },
          completedAt: "2026-08-12T00:05:00.000Z",
        });
        await finishBodyIfIdle(paths, { sequence: value.turn.bodySequence, at: "2026-08-12T00:05:00.000Z" });
        value.holder.release();
      }
      return await originalTry(paths);
    });
    try {
      const roster = await Akumas.of(await World.at(root)).list();
      const result =
        observation === "roster"
          ? roster.rows?.find((row) => row.id === value.allocated.id)
          : observation === "wait"
            ? await value.handle.wait(undefined, { timeoutMs: 1_000 })
            : await value.handle.status();
      assert.equal(finished, true);
      assert.equal(result?.life, "asleep");
      if (result !== undefined && "lifeAt" in result) assert.equal(result.lifeAt, "2026-08-12T00:05:00.000Z");
      if (result !== undefined && "timeline" in result) {
        assert.equal(result.timeline.kind, "idle");
        if (result.timeline.kind === "idle") assert.equal(result.timeline.outcome?.outcome.kind, "answered");
      }
    } finally {
      mockedTry.mock.restore();
      value.holder.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("a failed Heart refresh releases the observation's free leash claim", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-observe-corrupt-"));
  const value = await bornHistoryHandle(root, "f000000a");
  value.holder.release();
  const originalTry = HeldAkumaLeash.try;
  const mockedTry = t.mock.method(HeldAkumaLeash, "try", async (paths: typeof value.allocated.paths) => {
    const claim = await originalTry(paths);
    if (claim !== null) writeFileSync(paths.heart, "not a database");
    return claim;
  });
  try {
    // The observation keeps its Heart connection while the file's identity is unchanged, so
    // the truncated file is a malformed image to that live connection; only a fresh open
    // reports that it is not a database at all.
    await assert.rejects(value.handle.status(), /not a database|database disk image is malformed/u);
    mockedTry.mock.restore();
    assert.equal(await probeLeash(value.allocated.paths), "free");
  } finally {
    mockedTry.mock.restore();
    rmSync(root, { recursive: true, force: true });
  }
});

const provider: ProviderAdapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
  const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
  custody.own({ closed: eventsFinished, forceDispose: async () => {} });
  return {
    admission: { fence: "public-fixture-turn" },
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "session" as const, coordinate: { sessionId: "public-session" } };
        yield { type: "assistant" as const, text: "working" };
        finishEvents();
      },
    },
    completion: eventsFinished.then(() => ({
      kind: "answered" as const,
      answer: "public answer",
      historyId: "public-history",
    })),
  };
}));

test("turn owner folds a rejected completion while the event stream remains open", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-akuma-completion-rejection-")));
  const deferred = configureDeferredBodyEndPlugin(root);
  writeFileSync(deferred.release, "release\n");
  const { promise: completion, reject: rejectCompletion } = promiseBarrier<never>();
  const rejecting: ProviderAdapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    custody.own({ closed: completion.then(() => undefined, () => undefined), forceDispose: async () => {} });
    queueMicrotask(() => rejectCompletion(new Error("completion rejected")));
    return {
      admission: { fence: "completion-rejection" },
      events: {
        async *[Symbol.asyncIterator]() {
          await new Promise<void>(() => {});
        },
      },
      completion,
    };
  }));
  let driving: ReturnType<typeof driveAkumaBody> | undefined;
  try {
    const world = await World.at(root);
    const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "claude", draw: () => "deadbeef" });
    await initializeHeart(allocated.paths);
    driving = driveAkumaBody(claudeBodyLaunch(allocated, world, "work"), rejecting, {
      spawn: noBodyLaunch,
      now: () => "2026-08-24T00:00:00.000Z",
    });
    void driving.catch(() => undefined);
    await waitForFile(deferred.turnStarted);
    assert.equal(existsSync(deferred.turnSettled), false);
    const rows = (await activitySlice(allocated.paths)).rows;
    const outcome = rows.find((row) => row.kind === "turn-end");
    assert.ok(outcome, JSON.stringify(rows));
    assert.deepEqual(outcome.outcome, { kind: "failed", diagnostic: "completion rejected" });
  } finally {
    writeFileSync(deferred.turnRelease, "release\n");
    await driving;
    await waitForFile(deferred.turnSettled);
    rmSync(root, { recursive: true, force: true });
  }
});

async function answeredSource(root: string, suffix: string, bare?: boolean) {
  const world = await World.at(root);
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        akumaName: "claude",
        description: "Fork source",
        ...(bare === undefined ? {} : { bare }),
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model" },
        origin: { kind: "direct" },
        cwd: world,
      },
      initialBody: "work",
    },
    provider,
    { spawn: noBodyLaunch, now: () => "2026-08-08T00:00:00.000Z" },
  );
  return allocated;
}

type MutableProvider = {
  -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] | undefined;
};

function snapshot(
  ledger: TurnLedger,
  budget?: Readonly<{ tail: number }>,
  aperture: "monitoring" | "receipt" = "receipt",
): ActivitySnapshot {
  return selectSnapshot(ledger, { aperture, ...(budget === undefined ? {} : { budget }) }).snapshot;
}

test("snapshot selects one current focus while history keeps honest tool lifecycle", () => {
  const facts: readonly TimelineFact[] = [
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool",
      phase: "started",
      id: "old",
      name: "Bash",
      call: { kind: "run", command: "old" },
    }),
    turnEndFact(3, 1, "2026-08-10T00:00:03.000Z", {
      kind: "answered",
      answer: "old answer",
      session: { sessionId: "session" },
    }),
    { kind: "turn-start" as const, sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    { kind: "call" as const, sequence: 5, turnSequence: 4, at: "2026-08-10T00:00:04.000Z", body: "current" },
    activityFact(6, 4, "2026-08-10T00:00:05.000Z", { type: "note", text: "checking" }),
    {
      kind: "tell" as const,
      sequence: 7,
      id: "tell-1",
      body: "new direction",
      recordedAt: "2026-08-10T00:00:06.000Z",
      state: "pending" as const,
      deliveries: [],
    },
    activityFact(8, 4, "2026-08-10T00:00:07.000Z", {
      type: "tool",
      phase: "started",
      id: "current",
      name: "Search",
      call: { kind: "search", query: "TODO" },
    }),
  ];
  const ledger = projectTurns(facts);
  const selected = snapshot(ledger, { tail: 1 });
  assert.ok(selected.kind === "open", 'expected selected.kind = "open"');
  assert.deepEqual(
    selected.entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence)),
    [5, 6, 7, 8],
  );
  assert.equal(
    selected.entries.some((entry) => entry.kind === "row" && entry.row.kind === "tool" && entry.row.state === "active"),
    true,
  );
  assert.equal(
    selected.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 2),
    false,
  );
  assert.equal(
    ledger.rows.some((row) => row.kind === "tool" && row.sequence === 2 && row.state === "unsettled"),
    true,
  );
  assert.equal(
    ledger.rows.some((row) => row.kind === "tool" && row.sequence === 8 && row.state === "active"),
    true,
  );
  assert.equal(ledger.turns[0]?.kind, "closed");
  assert.equal(ledger.turns[1]?.kind, "open");
  assert.equal(
    ledger.openTurn?.rows.some((row) => row.kind === "tool" && row.state === "active"),
    true,
  );

  const closed = projectTurns([
    ...facts,
    activityFact(9, 4, "2026-08-10T00:00:08.000Z", { type: "assistant", text: "done" }),
    turnEndFact(10, 4, "2026-08-10T00:00:09.000Z", {
      kind: "answered",
      answer: "done",
      session: { sessionId: "session" },
    }),
  ]);
  const idle = snapshot(closed);
  assert.ok(idle.kind === "idle", 'expected idle.kind = "idle"');
  assert.equal(idle.outcome?.outcome.kind, "answered");
  assert.deepEqual(
    idle.entries.map((entry) => (entry.kind === "gap" ? `gap:${entry.count}` : entry.row.sequence)),
    [7],
  );
  assert.equal(
    closed.rows.some((row) => row.kind === "said" && row.sequence === 9),
    false,
  );
  assert.equal(
    closed.rows.some((row) => row.kind === "tool" && row.sequence === 8 && row.state === "unsettled"),
    true,
  );
  assert.equal(closed.turns[1]?.kind, "closed");
  if (closed.turns[1]?.kind === "closed") {
    assert.equal(
      closed.turns[1].rows.some((row) => row.kind === "tool" && row.state === "unsettled"),
      true,
    );
  }

  const mixedLedger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool",
      phase: "started",
      id: "abandoned",
      name: "Bash",
      call: { kind: "run", command: "old" },
    }),
    { kind: "turn-start", sequence: 3, bodySequence: 2, startedAt: "2026-08-10T00:00:03.000Z" },
    turnEndFact(4, 3, "2026-08-10T00:00:04.000Z", { kind: "failed", diagnostic: "latest failed" }),
  ]);
  assert.equal(mixedLedger.turns[0]?.kind, "open");
  assert.equal(mixedLedger.turns[1]?.kind, "closed");
  assert.equal(mixedLedger.openTurn, undefined);
  assert.equal(
    mixedLedger.rows.some((row) => row.kind === "tool" && row.sequence === 2 && row.state === "active"),
    true,
  );
  assert.equal(snapshot(mixedLedger).kind, "idle");
});

function snapshotSequences(snapshot: ActivitySnapshot): readonly (number | `gap:${number}`)[] {
  return snapshot.entries.map((entry) =>
    entry.kind === "gap" ? (`gap:${entry.count}` as `gap:${number}`) : entry.row.sequence,
  );
}

test("open snapshots retain one current-Turn opening input outside the ordinary budget", () => {
  const callLedger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "call" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", body: "earlier" },
    turnEndFact(3, 1, "2026-08-10T00:00:03.000Z", {
      kind: "answered",
      answer: "earlier",
      session: { sessionId: "earlier" },
    }),
    { kind: "turn-start" as const, sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    { kind: "call" as const, sequence: 5, turnSequence: 4, at: "2026-08-10T00:00:05.000Z", body: "current" },
    activityFact(6, 4, "2026-08-10T00:00:06.000Z", { type: "assistant", text: "one" }),
    activityFact(7, 4, "2026-08-10T00:00:07.000Z", { type: "thought", text: "two" }),
    activityFact(8, 4, "2026-08-10T00:00:08.000Z", { type: "note", text: "three" }),
    activityFact(9, 4, "2026-08-10T00:00:09.000Z", { type: "assistant", text: "four" }),
    activityFact(10, 4, "2026-08-10T00:00:10.000Z", { type: "thought", text: "five" }),
    activityFact(11, 4, "2026-08-10T00:00:11.000Z", { type: "note", text: "six" }),
  ]);
  const zero = selectSnapshot(callLedger, { aperture: "receipt", budget: { tail: 0 } });
  assert.equal(zero.snapshot.kind, "open");
  if (zero.snapshot.kind === "open") {
    assert.equal(zero.snapshot.openingSequence, 5);
    assert.deepEqual(snapshotSequences(zero.snapshot), [5, "gap:3", 9, "gap:2"]);
  }
  assert.equal(zero.ordinaryCount, 0);

  const defaultBudget = selectSnapshot(callLedger, { aperture: "receipt" });
  assert.equal(defaultBudget.snapshot.kind, "open");
  if (defaultBudget.snapshot.kind === "open") {
    assert.equal(defaultBudget.snapshot.openingSequence, 5);
    assert.equal(snapshotSequences(defaultBudget.snapshot).filter((sequence) => sequence === 5).length, 1);
    assert.equal(snapshotSequences(defaultBudget.snapshot).includes(2), false);
  }
  assert.equal(defaultBudget.ordinaryCount, 3);
});

test("open snapshots protect the latest say but select file changes as ordinary tools", () => {
  const completedTool = (sequence: number, id: string, call: ToolCall) =>
    activityFact(sequence, 1, `2026-08-10T00:00:${String(sequence).padStart(2, "0")}.000Z`, {
      type: "tool",
      phase: "completed",
      id,
      name: "tool",
      call,
      result: { status: "ok" },
    });
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    { kind: "call" as const, sequence: 2, turnSequence: 1, at: "2026-08-10T00:00:02.000Z", body: "current" },
    completedTool(3, "ordinary-1", { kind: "run", command: "ordinary-1" }),
    activityFact(4, 1, "2026-08-10T00:00:04.000Z", { type: "assistant", text: "say one" }),
    completedTool(5, "file-1", { kind: "fileChange", changes: [{ op: "update", path: "src/one.ts" }] }),
    completedTool(6, "ordinary-2", { kind: "run", command: "ordinary-2" }),
    activityFact(7, 1, "2026-08-10T00:00:07.000Z", { type: "assistant", text: "say two" }),
    completedTool(8, "file-2", {
      kind: "fileChange",
      changes: [{ op: "update", path: "src/two.ts", diffstat: { added: 4, removed: 2 } }],
    }),
  ]);
  const zero = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 0 } });

  assert.equal(zero.snapshot.kind, "open");
  if (zero.snapshot.kind === "open") {
    assert.deepEqual(snapshotSequences(zero.snapshot), [2, "gap:4", 7, "gap:1"]);
  }
  assert.equal(zero.ordinaryCount, 0);

  const selected = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 1 } });
  assert.equal(selected.snapshot.kind, "open");
  if (selected.snapshot.kind === "open") {
    assert.deepEqual(snapshotSequences(selected.snapshot), [2, "gap:4", 7, 8]);
    const edit = selected.snapshot.entries.find((entry) => entry.kind === "row" && entry.row.sequence === 8);
    assert.equal(edit?.kind, "row");
    if (edit?.kind === "row" && edit.row.kind === "tool" && edit.row.call.kind === "fileChange") {
      assert.equal(edit.row.call.changes[0]?.path, "src/two.ts");
      assert.deepEqual(edit.row.call.changes[0]?.diffstat, { added: 4, removed: 2 });
    } else assert.fail("the selected ordinary edit retains its typed file-change evidence");
  }
  assert.equal(selected.ordinaryCount, 1);
});

test("open snapshots select the retained launch Tell only without a current-Turn call", () => {
  const facts: readonly TimelineFact[] = [
    {
      kind: "tell",
      sequence: 1,
      id: "opening",
      body: "wake this Turn",
      recordedAt: "2026-08-10T00:00:01.000Z",
      state: "told",
      deliveries: [{ route: "launch", turnSequence: 4, deliveredAt: "2026-08-10T00:00:02.000Z" }],
    },
    {
      kind: "tell",
      sequence: 2,
      id: "later-launch",
      body: "also at launch",
      recordedAt: "2026-08-10T00:00:02.000Z",
      state: "told",
      deliveries: [{ route: "launch", turnSequence: 4, deliveredAt: "2026-08-10T00:00:03.000Z" }],
    },
    { kind: "turn-start", sequence: 4, bodySequence: 1, startedAt: "2026-08-10T00:00:04.000Z" },
    activityFact(5, 4, "2026-08-10T00:00:05.000Z", { type: "assistant", text: "working" }),
    {
      kind: "tell",
      sequence: 6,
      id: "other-turn",
      body: "old launch",
      recordedAt: "2026-08-10T00:00:06.000Z",
      state: "told",
      deliveries: [{ route: "launch", turnSequence: 1, deliveredAt: "2026-08-10T00:00:06.000Z" }],
    },
    {
      kind: "tell",
      sequence: 7,
      id: "live",
      body: "steer current work",
      recordedAt: "2026-08-10T00:00:07.000Z",
      state: "told",
      deliveries: [{ route: "live", turnSequence: 4, receipt: "required", deliveredAt: "2026-08-10T00:00:07.000Z" }],
    },
    activityFact(8, 4, "2026-08-10T00:00:08.000Z", { type: "note", text: "still working" }),
  ];
  const launch = selectSnapshot(projectTurns(facts), { aperture: "receipt", budget: { tail: 0 } });
  assert.equal(launch.snapshot.kind, "open");
  if (launch.snapshot.kind === "open") {
    assert.equal(launch.snapshot.openingSequence, 1);
    assert.deepEqual(snapshotSequences(launch.snapshot), [1, "gap:1", 5, "gap:2"]);
    assert.equal(launch.snapshot.entries.filter((entry) => entry.kind === "row" && entry.row.sequence === 1).length, 1);
    assert.equal(
      launch.snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 6),
      false,
    );
    assert.equal(
      launch.snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 7),
      false,
    );
    assert.equal(
      launch.snapshot.entries.some((entry) => entry.kind === "row" && entry.row.sequence === 2),
      false,
    );
  }

  const callWins = selectSnapshot(
    projectTurns([
      {
        kind: "tell" as const,
        sequence: 1,
        id: "launch",
        body: "launch input",
        recordedAt: "2026-08-10T00:00:01.000Z",
        state: "told" as const,
        deliveries: [{ route: "launch" as const, turnSequence: 2, deliveredAt: "2026-08-10T00:00:01.000Z" }],
      },
      { kind: "turn-start" as const, sequence: 2, bodySequence: 1, startedAt: "2026-08-10T00:00:02.000Z" },
      { kind: "call" as const, sequence: 3, turnSequence: 2, at: "2026-08-10T00:00:03.000Z", body: "call wins" },
    ]),
    { aperture: "receipt", budget: { tail: 0 } },
  ).snapshot;
  assert.equal(callWins.kind, "open");
  if (callWins.kind === "open") assert.equal(callWins.openingSequence, 3);

  const liveOnly = selectSnapshot(
    projectTurns(facts.filter((fact) => fact.kind !== "tell" || fact.id === "other-turn" || fact.id === "live")),
    { aperture: "receipt", budget: { tail: 0 } },
  ).snapshot;
  assert.equal(liveOnly.kind, "open");
  if (liveOnly.kind === "open") assert.equal(liveOnly.openingSequence, undefined);
});

test("opening input composes with existing actionable and receipt pins without a second copy", () => {
  const ledger = projectTurns([
    {
      kind: "tell" as const,
      sequence: 1,
      id: "opening",
      body: "wake this Turn",
      recordedAt: "2026-08-10T00:00:01.000Z",
      state: "told" as const,
      deliveries: [{ route: "launch" as const, turnSequence: 2, deliveredAt: "2026-08-10T00:00:01.000Z" }],
    },
    { kind: "turn-start" as const, sequence: 2, bodySequence: 1, startedAt: "2026-08-10T00:00:02.000Z" },
    activityFact(3, 2, "2026-08-10T00:00:03.000Z", { type: "assistant", text: "one" }),
    activityFact(4, 2, "2026-08-10T00:00:04.000Z", { type: "note", text: "two" }),
    activityFact(5, 2, "2026-08-10T00:00:05.000Z", {
      type: "tool",
      phase: "started",
      id: "active",
      name: "Search",
      call: { kind: "search", query: "TODO" },
    }),
    {
      kind: "tell" as const,
      sequence: 6,
      id: "pending",
      body: "keep going",
      recordedAt: "2026-08-10T00:00:06.000Z",
      state: "pending" as const,
      deliveries: [],
    },
    {
      kind: "tell" as const,
      sequence: 7,
      id: "receipt",
      body: "receipt evidence",
      recordedAt: "2026-08-10T00:00:07.000Z",
      state: "told" as const,
      deliveries: [
        {
          route: "live" as const,
          turnSequence: 2,
          receipt: "required" as const,
          deliveredAt: "2026-08-10T00:00:07.000Z",
        },
      ],
    },
  ]);
  const monitoring = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 0 } });
  assert.equal(monitoring.snapshot.kind, "open");
  if (monitoring.snapshot.kind === "open") {
    assert.equal(monitoring.snapshot.openingSequence, 1);
    assert.deepEqual(snapshotSequences(monitoring.snapshot), [1, 3, "gap:1", 5, 6, "gap:1"]);
  }
  assert.equal(monitoring.ordinaryCount, 0);
  const budgeted = selectSnapshot(ledger, { aperture: "monitoring", budget: { tail: 1 } });
  assert.equal(budgeted.snapshot.kind, "open");
  if (budgeted.snapshot.kind === "open")
    assert.deepEqual(snapshotSequences(budgeted.snapshot), [1, 3, "gap:1", 5, 6, 7]);
  assert.equal(budgeted.ordinaryCount, 1);
  const receipt = selectSnapshot(ledger, {
    aperture: "receipt",
    admittedTellId: "receipt",
    budget: { tail: 0 },
  }).snapshot;
  assert.equal(receipt.kind, "open");
  if (receipt.kind === "open") {
    assert.equal(receipt.openingSequence, 1);
    assert.deepEqual(snapshotSequences(receipt), [1, 3, "gap:1", 5, 7]);
    assert.equal(receipt.entries.filter((entry) => entry.kind === "row" && entry.row.sequence === 1).length, 1);
  }
});

test("opening identity is positive and names exactly one open snapshot entry", () => {
  const open = activitySnapshotSchema.parse({
    kind: "open",
    turn: { kind: "turn", sequence: 1, bodySequence: 1, at: "2026-08-10T00:00:01.000Z" },
    entries: [
      {
        kind: "row",
        row: { kind: "call", sequence: 1, turnSequence: 1, at: "2026-08-10T00:00:01.000Z", text: "opening" },
      },
    ],
    openingSequence: 1,
    reportedChanges: [],
    reportedChangesOmitted: 0,
  });
  assert.equal(open.kind, "open");
  assert.throws(() =>
    activitySnapshotSchema.parse({
      kind: "open",
      turn: { kind: "turn", sequence: 1, bodySequence: 1, at: "2026-08-10T00:00:01.000Z" },
      entries: [],
      openingSequence: 1,
      reportedChanges: [],
      reportedChangesOmitted: 0,
    }),
  );
  assert.throws(() =>
    activitySnapshotSchema.parse({
      kind: "open",
      turn: { kind: "turn", sequence: 1, bodySequence: 1, at: "2026-08-10T00:00:01.000Z" },
      entries: [
        {
          kind: "row",
          row: { kind: "call", sequence: 1, turnSequence: 1, at: "2026-08-10T00:00:01.000Z", text: "opening" },
        },
      ],
      openingSequence: 0,
      reportedChanges: [],
      reportedChangesOmitted: 0,
    }),
  );
  assert.throws(() =>
    activitySnapshotSchema.parse({
      kind: "unborn",
      entries: [],
      openingSequence: 1,
      reportedChanges: [],
      reportedChangesOmitted: 0,
    }),
  );
  assert.throws(() =>
    activitySnapshotSchema.parse({
      kind: "idle",
      entries: [],
      openingSequence: 1,
      reportedChanges: [],
      reportedChangesOmitted: 0,
    }),
  );
});

test("reported file changes follow the open or latest closed frontier and aggregate files", () => {
  const earlierCall = { kind: "fileChange" as const, changes: [{ op: "add" as const, path: "src/earlier.ts" }] };
  const frontierCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/created.ts", diffstat: { added: 4, removed: 0 } },
      { op: "update" as const, path: "src/repeated.ts", diffstat: { added: 2, removed: 1 } },
      { op: "delete" as const, path: "src/removed.ts", diffstat: { added: 0, removed: 3 } },
      { op: "update" as const, path: "src/unknown.ts" },
      { op: "update" as const, path: "src/repeated.ts", diffstat: { added: 1, removed: 0 } },
    ],
  };
  const failedCall = { kind: "fileChange" as const, changes: [{ op: "add" as const, path: "src/failed.ts" }] };
  const activeCall = { kind: "fileChange" as const, changes: [{ op: "delete" as const, path: "src/active.ts" }] };
  const facts = [
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "earlier",
      name: "Write",
      call: earlierCall,
    }),
    activityFact(3, 1, "2026-08-10T00:00:03.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "earlier",
      name: "Write",
      call: earlierCall,
      result: { status: "ok" as const },
    }),
    turnEndFact(4, 1, "2026-08-10T00:00:04.000Z", {
      kind: "answered" as const,
      answer: "earlier",
      session: { sessionId: "earlier" },
    }),
    { kind: "turn-start" as const, sequence: 5, bodySequence: 1, startedAt: "2026-08-10T00:00:05.000Z" },
    activityFact(6, 5, "2026-08-10T00:00:06.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "frontier",
      name: "Write",
      call: frontierCall,
    }),
    activityFact(7, 5, "2026-08-10T00:00:07.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "frontier",
      name: "Write",
      call: frontierCall,
      result: { status: "ok" as const },
    }),
    activityFact(8, 5, "2026-08-10T00:00:08.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "failed",
      name: "Write",
      call: failedCall,
    }),
    activityFact(9, 5, "2026-08-10T00:00:09.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "failed",
      name: "Write",
      call: failedCall,
      result: { status: "error" as const },
    }),
    activityFact(10, 5, "2026-08-10T00:00:10.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "active",
      name: "Write",
      call: activeCall,
    }),
    activityFact(11, 5, "2026-08-10T00:00:11.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "run",
      name: "Bash",
      call: { kind: "run" as const, command: "touch src/non-file.ts" },
    }),
    activityFact(12, 5, "2026-08-10T00:00:12.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "run",
      name: "Bash",
      call: { kind: "run" as const, command: "touch src/non-file.ts" },
      result: { status: "ok" as const },
    }),
  ];
  const reported = (view: ActivitySnapshot) => view.reportedChanges;
  const openLedger = projectTurns(facts);
  const openFrontier = openLedger.openTurn?.rows.find(
    (row) => row.kind === "tool" && row.call.kind === "fileChange" && row.sequence === 7,
  );
  assert.ok(openFrontier !== undefined && openFrontier.kind === "tool" && openFrontier.call.kind === "fileChange");
  (openFrontier.call.changes[3] as unknown as { op: "unspecified" }).op = "unspecified";

  const open = snapshot(openLedger);
  assert.equal(open.kind, "open");
  assert.deepEqual(reported(open), [
    {
      path: "src/created.ts",
      diffstat: { added: 4, removed: 0 },
    },
    {
      path: "src/removed.ts",
      diffstat: { added: 0, removed: 3 },
    },
    { path: "src/unknown.ts" },
    {
      path: "src/repeated.ts",
      diffstat: { added: 3, removed: 1 },
    },
  ]);
  assert.equal(open.reportedChangesOmitted, 0);

  const closedLedger = projectTurns([
    ...facts,
    turnEndFact(13, 5, "2026-08-10T00:00:13.000Z", {
      kind: "answered" as const,
      answer: "frontier",
      session: { sessionId: "frontier" },
    }),
  ]);
  const closedFrontier = closedLedger.turns.at(-1);
  assert.ok(closedFrontier?.kind === "closed");
  const closedChange = closedFrontier.rows.find(
    (row) => row.kind === "tool" && row.call.kind === "fileChange" && row.sequence === 7,
  );
  assert.ok(closedChange !== undefined && closedChange.kind === "tool" && closedChange.call.kind === "fileChange");
  (closedChange.call.changes[3] as unknown as { op: "unspecified" }).op = "unspecified";

  const idle = snapshot(closedLedger);
  assert.equal(idle.kind, "idle");
  assert.deepEqual(reported(idle), reported(open));
  assert.equal(idle.reportedChangesOmitted, 0);
});

test("reported file changes keep the newest five independently of ordinary omissions", () => {
  const firstCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/one.ts" },
      { op: "update" as const, path: "src/two.ts" },
      { op: "delete" as const, path: "src/three.ts", diffstat: { added: 0, removed: 3 } },
    ],
  };
  const secondCall = {
    kind: "fileChange" as const,
    changes: [
      { op: "add" as const, path: "src/four.ts" },
      { op: "update" as const, path: "src/five.ts" },
      { op: "delete" as const, path: "src/six.ts" },
      { op: "add" as const, path: "src/seven.ts" },
      { op: "update" as const, path: "src/three.ts" },
    ],
  };
  const ledger = projectTurns([
    { kind: "turn-start" as const, sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "first",
      name: "Write",
      call: firstCall,
    }),
    activityFact(3, 1, "2026-08-10T00:00:03.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "first",
      name: "Write",
      call: firstCall,
      result: { status: "ok" as const },
    }),
    activityFact(4, 1, "2026-08-10T00:00:04.000Z", { type: "note" as const, text: "ordinary one" }),
    activityFact(5, 1, "2026-08-10T00:00:05.000Z", {
      type: "tool" as const,
      phase: "started" as const,
      id: "second",
      name: "Write",
      call: secondCall,
    }),
    activityFact(6, 1, "2026-08-10T00:00:06.000Z", {
      type: "tool" as const,
      phase: "completed" as const,
      id: "second",
      name: "Write",
      call: secondCall,
      result: { status: "ok" as const },
    }),
    activityFact(7, 1, "2026-08-10T00:00:07.000Z", { type: "note" as const, text: "ordinary two" }),
    activityFact(8, 1, "2026-08-10T00:00:08.000Z", { type: "note" as const, text: "ordinary three" }),
  ]);
  const view = snapshot(ledger, { tail: 0 });
  assert.equal(view.kind, "open");
  assert.deepEqual(
    view.reportedChanges.map((change) => change.path),
    ["src/four.ts", "src/five.ts", "src/six.ts", "src/seven.ts", "src/three.ts"],
  );
  assert.equal(view.reportedChanges.at(-1)?.diffstat, undefined);
  assert.equal(view.reportedChangesOmitted, 2);
  assert.deepEqual(snapshotSequences(view), ["gap:5"]);
});

test("outcome folding carries the exact omitted final said identity through public schemas", () => {
  const at = "2026-10-15T00:00:00.000Z";
  const facts: TimelineFact[] = [
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: at },
    activityFact(2, 1, at, { type: "assistant", text: "same answer" }),
    activityFact(3, 1, at, { type: "assistant", text: "same answer" }),
  ];
  assert.equal(projectTurns(facts).rows.filter((row) => row.kind === "said").length, 2);
  const ledger = projectTurns([
    ...facts,
    turnEndFact(4, 1, at, {
      kind: "answered",
      answer: "same answer",
      session: { sessionId: "session" },
    }),
  ]);
  assert.deepEqual(
    ledger.rows.map((row) => [row.kind, row.sequence]),
    [
      ["turn", 1],
      ["said", 2],
      ["outcome", 4],
    ],
  );
  const outcome = ledger.latestOutcome?.outcome;
  assert.ok(outcome?.kind === "answered");
  assert.equal(outcome.foldedSaidSequence, 3, "only the producer's final narration is the linked duplicate");
  const view = selectSnapshot(ledger, { aperture: "monitoring" }).snapshot;
  assert.deepEqual(activitySnapshotSchema.parse(view), view, "public schema preserves answered fold identity");
  const unequal = projectTurns([
    ...facts,
    turnEndFact(4, 1, at, {
      kind: "answered",
      answer: "different answer",
      session: { sessionId: "session" },
    }),
  ]);
  assert.equal(unequal.rows.filter((row) => row.kind === "said").length, 2, "unequal narration is retained");
  const unequalOutcome = unequal.latestOutcome?.outcome;
  assert.ok(unequalOutcome?.kind === "answered");
  assert.equal(unequalOutcome.foldedSaidSequence, undefined, "unequal narration receives no folded identity");
});

test("outcome folding preserves a truncated final voice equal to the answer", () => {
  const ledger = projectTurns([
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: "2026-08-10T00:00:01.000Z" },
    activityFact(2, 1, "2026-08-10T00:00:02.000Z", { type: "assistant", text: "same answer", truncated: true }),
    turnEndFact(3, 1, "2026-08-10T00:00:03.000Z", {
      kind: "answered",
      answer: "same answer",
      session: { sessionId: "session" },
    }),
  ]);

  assert.equal(
    ledger.rows.some((row) => row.kind === "said" && row.text === "same answer" && row.truncated === true),
    true,
  );
  assert.deepEqual(
    selectHistory(ledger, { limit: 50 }).rows.map((row) => row.kind),
    ["turn", "said", "outcome"],
  );
  assert.ok(ledger.latestOutcome?.outcome.kind === "answered");
  assert.equal(
    ledger.latestOutcome.outcome.foldedSaidSequence,
    undefined,
    "unfolded narration has no replacement identity",
  );
});

test("wait timeout returns the same running status carrier", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-wait-timeout-");
  const source = await answeredSource(root, "de1ad100");
  const leash = (await HeldAkumaLeash.try(source.paths))!;
  try {
    const handle = new AkumaOwner(source.id, await World.at(root));
    const expected = await handle.status();
    assert.equal(expected.life, "running");
    assert.deepEqual(await handle.wait(undefined, { timeoutMs: 0 }), expected);
  } finally {
    leash.release();
  }
});

test("an answered Turn without a fork point remains visible and keeps its answer", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-no-fork-point-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "f0a10006" });
  await initializeHeart(allocated.paths);
  const noPointProvider: ProviderAdapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
    custody.own({ closed: eventsFinished, forceDispose: async () => {} });
    return {
      admission: { fence: "no-point-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "no-point-session" } };
          finishEvents();
        },
      },
      completion: eventsFinished.then(() => ({
        kind: "answered" as const,
        answer: "complete without fork",
      })),
    };
  }));
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        akumaName: "claude",
        description: "No fork point",
        provider: CLAUDE_EXECUTION,
        options: { model: "fixture-model" },
        origin: { kind: "direct" },
        cwd: root,
      },
      initialBody: "work",
    },
    noPointProvider,
    { spawn: noBodyLaunch, now: () => "2026-08-08T00:00:00.000Z" },
  );

  const handle = new AkumaOwner(allocated.id, await World.at(root));
  assert.deepEqual(await handle.lastAnswer(), { kind: "answer", answer: "complete without fork" });
  assert.deepEqual(historyPage(await handle.history()).rows.find((row) => row.kind === "outcome")?.outcome, {
    kind: "answered",
    answer: "complete without fork",
  });
  const exact = await handle.history({ id: "turn/1" });
  if (!("kind" in exact) || exact.kind !== "exact") throw new Error("expected exact history");
  assert.deepEqual(await handle.fork({ at: "missing-point" }, spawnAkumaBody), { kind: "unknown-history" });
});

test("SDK fork records its invoking caller independently of source lineage and emits born", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-fork-caller-");
  const world = await World.at(root);
  mkdirSync(join(root, "plugins"));
  const output = join(root, "births.jsonl");
  writeFileSync(
    join(root, "plugins", "birth.mjs"),
    `
    import { appendFileSync } from "node:fs";
    export default { manifest: { id: "birth", apiVersion: 1 }, activate(context) {
      return { signals: { "akuma.born": (signal) => appendFileSync(context.config.output, JSON.stringify(signal) + "\\n") } };
    } };
  `,
  );
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        birth: { package: "./plugins/birth.mjs", config: { output } },
      },
    }),
  );
  const source = await answeredSource(root, "f0a10001");
  const mutable = claudeProvider as MutableProvider;
  const original = mutable.fork;
  mutable.fork = () => createProviderAttempt(undefined, async () => ({ session: { sessionId: "native-fork" } }));
  try {
    const caller = {
      kind: "akuma" as const,
      world,
      akumaId: parseAkumaId("aku/delegator/1234abcd").id,
    };
    const receipt = await Akumas.of(world).fork({
      akuma: source.id,
      at: "turn/1",
      caller,
      initiator: "Invoker",
      bare: true,
    });
    assert.equal(receipt.kind, "forked");
    if (receipt.kind !== "forked") return;
    const child = pathsForAkumaId(world, receipt.childAkumaId);
    assert.equal((await readHeart(child)).soul?.bare, true);
    assert.equal((await readHeart(source.paths)).soul?.bare, undefined, "fork does not change its source");
    const status = await new AkumaOwner(receipt.childAkumaId, world).status();
    assert.deepEqual(status.birth, { origin: { kind: "fork", parent: source.id, at: "turn/1" }, caller });
    const signals = readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(signals.length, 2);
    assert.deepEqual(signals[1], {
      kind: "akuma.born",
      akumaId: receipt.childAkumaId,
      bodySequence: 1,
      ...status.birth,
      initiator: "Invoker",
    });
    const bareSource = await answeredSource(root, "f0a10004", true);
    const inherited = await Akumas.of(world).fork({ akuma: bareSource.id, at: "turn/1", bare: false });
    assert.equal(inherited.kind, "forked");
    if (inherited.kind === "forked") {
      assert.equal(
        (await readHeart(pathsForAkumaId(world, inherited.childAkumaId))).soul?.bare,
        true,
        "false cannot undo a source's frozen opt-out",
      );
    }
    const launches: BodyLaunch[] = [];
    const bodies: Promise<unknown>[] = [];
    const spawn: BodyLauncher = async (launch) => {
      launches.push(launch);
      const body = driveAkumaBody(launch, provider, { spawn, world });
      bodies.push(body);
      return { completed: body.then(() => ({ diagnostic: "fork launch completed" })), async cancel() {}, release() {} };
    };
    const second = await akumasWithLauncher(world, spawn).fork({
      akuma: source.id,
      at: "turn/1",
      caller,
    });
    await Promise.all(bodies);
    assert.equal(second.kind, "forked");
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.birthSession?.coordinate.sessionId, "native-fork");
    assert.deepEqual(launches[0]?.seed?.origin, { kind: "fork", parent: source.id, at: "turn/1" });
    assert.equal((await readHeart(launches[0]!.paths)).latestBody?.end, "exited");
  } finally {
    mutable.fork = original;
  }
});

test("fork preserves categorical, exact-history, native, local, and not-born failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-results-"));
  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    const source = await answeredSource(root, "f0a10002");
    const handle = new AkumaOwner(source.id, await World.at(root));

    delete mutable.fork;
    assert.deepEqual(await handle.fork({ at: "missing" }, spawnAkumaBody), {
      kind: "provider-cannot-fork",
    });

    let nativeCalls = 0;
    mutable.fork = () =>
      createProviderAttempt(undefined, async () => {
        nativeCalls += 1;
        throw new Error("native refused");
      });
    assert.deepEqual(await handle.fork({ at: "missing" }, spawnAkumaBody), { kind: "unknown-history" });
    assert.equal(nativeCalls, 0);
    assert.deepEqual(await handle.fork({ at: "turn/1" }, spawnAkumaBody), {
      kind: "fork-failed",
      diagnostic: "native refused",
    });

    mutable.fork = () =>
      createProviderAttempt(undefined, async () => {
        const runRoot = akumaRunRoot(root);
        rmSync(runRoot, { recursive: true, force: true });
        writeFileSync(runRoot, "blocked");
        return { session: { sessionId: "orphan-upstream-session" } };
      });
    const partial = await handle.fork({ at: "turn/1" }, spawnAkumaBody);
    assert.equal(partial.kind, "provider-forked-local-birth-failed");
    if (partial.kind === "provider-forked-local-birth-failed") {
      assert.deepEqual(partial.session, { kind: "session", sessionId: "orphan-upstream-session" });
      assert.match(partial.diagnostic, /exist|directory|not a directory/i);
    }

    const unbornRoot = mkdtempSync(join(tmpdir(), "keiyaku-akuma-fork-unborn-"));
    try {
      const unborn = await allocateAkumaDirectory({
        worldRoot: unbornRoot,
        akumaName: "claude",
        draw: () => "f0a10003",
      });
      await assert.rejects(
        new AkumaOwner(unborn.id, await World.at(unbornRoot)).fork({ at: "anything" }, spawnAkumaBody),
        AkumaNotBornError,
      );
    } finally {
      rmSync(unbornRoot, { recursive: true, force: true });
    }
  } finally {
    mutable.fork = originalFork;
    rmSync(root, { recursive: true, force: true });
  }
});

test("public Akuma handles separate compact list rows from full status and wait", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-public-");
  const world = Akumas.of(await World.at(root));
  const empty = await world.list();
  assert.equal(empty.rows, undefined, "an empty roster omits rows");
  assert.equal(empty.more, undefined, "a complete roster omits more");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "1234abcd" });
  await initializeHeart(allocated.paths);
  await moveAlias({ world: root as WorldRoot, alias: parseAkumaAlias("@early"), akumaId: allocated.id });
  const unbornRows = (await world.list()).rows;
  assert.ok(unbornRows !== undefined);
  assert.equal(unbornRows[0]?.life, "unborn");
  assert.deepEqual(unbornRows[0]?.aliases, ["@early"]);
  assert.equal((await world.list({ akumaName: "claude" })).rows?.[0]?.id, allocated.id);
  assert.equal((await world.list({ akumaName: "reviewer" })).rows, undefined);
  await assert.rejects(world.list({ akumaName: "not/a-name" }), /Akuma name/);
  await assert.rejects(world.list({ unknown: true } as never), /unknown field: unknown/);

  const launch: BodyLaunch = {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      akumaName: "claude",
      description: "Fixture akuma",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      cwd: root,
    },
    initialBody: "work",
  };
  await driveAkumaBody(launch, provider, { spawn: noBodyLaunch, now: () => "2026-08-08T00:00:00.000Z" });

  const handle = new AkumaOwner(allocated.id, await World.at(root));
  const listedRows = (await world.list()).rows;
  assert.ok(listedRows !== undefined);
  const listed = listedRows[0];
  assert.equal(listed?.life, "asleep");
  assert.equal(listed?.life === "asleep" && listed.lifeAt, "2026-08-08T00:00:00.000Z");
  assert.equal("history" in (listed ?? {}), false);
  assert.equal("answer" in (listed ?? {}), false);
  assert.equal(listed?.id.split("/")[1], "claude", "the roster identity carries the frozen akuma name");
  assert.equal("description" in (listed ?? {}), false, "the public roster omits descriptions");
  assert.equal(listed?.life === "asleep" && listed.pending, undefined, "known-empty pending is omitted");
  const status = await handle.status();
  assert.equal(status.life, "asleep");
  assert.equal(status.cwd, root, "status reports the Akuma's frozen execution workdir");
  assert.equal("akumaName" in status, false);
  assert.equal("description" in status, false);
  assert.equal("pending" in status, false);
  assert.equal(status.timeline.kind, "idle");
  assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.outcome.kind === "answered", true);
  assert.equal(status.timeline.kind === "idle" && status.timeline.outcome?.turnSequence, 1);
  assert.equal("history" in status, false);
  assert.deepEqual(historyPage(await handle.history()).rows.find((row) => row.kind === "outcome")?.outcome, {
    kind: "answered",
    answer: "public answer",
  });
  const exact = await handle.history({ id: "turn/1" });
  if (!("kind" in exact) || exact.kind !== "exact") throw new Error("expected exact history");
  assert.deepEqual(exact.outcome.outcome, { kind: "answered", answer: "public answer" });
  assert.equal(status.timeline.entries.length, 0);
  assert.deepEqual(
    await handle.wait(
      (candidate) => candidate.timeline.kind === "idle" && candidate.timeline.outcome?.outcome.kind === "answered",
    ),
    status,
  );
  assert.equal(await handle.kill(noBodyLaunch), "already-stopped");
  assert.equal((await handle.status()).life, "asleep");
  const finalStatus = await handle.status();
  assert.equal(finalStatus.timeline.kind === "idle" && finalStatus.timeline.outcome?.outcome.kind === "answered", true);
  assert.equal(await handle.kill(noBodyLaunch), "already-stopped");
  assert.equal((await readHeart(allocated.paths)).pause, null);
  assert.deepEqual((await timeline(allocated.paths)).find((fact) => fact.kind === "turn-end")?.outcome, {
    kind: "answered",
    answer: "public answer",
    historyId: "public-history",
    session: { sessionId: "public-session" },
  });
});

test("caller roster follows frozen Soul edges across archetypes before its bound", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-caller-roster-");
  const proved = await World.at(root);
  const world = Akumas.of(proved);
  const rootCaller = { kind: "external", integration: "test", id: "root" } as const;
  const akumaCaller = (akumaId: string): AkumaCaller =>
    ({ kind: "akuma", world: proved, akumaId: akumaId as never }) as AkumaCaller;
  const direct = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110001",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller: rootCaller,
  });
  const sibling = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110002",
    createdAt: "2026-08-08T00:00:02.000Z",
    caller: rootCaller,
  });
  const grandchild = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110003",
    createdAt: "2026-08-08T00:00:03.000Z",
    caller: akumaCaller(direct.id),
  });
  const greatGrandchild = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110004",
    createdAt: "2026-08-08T00:00:04.000Z",
    caller: akumaCaller(grandchild.id),
  });
  const delegation = await bornLineageAkuma({
    root,
    akumaName: "delegator",
    draw: "ca110005",
    createdAt: "2026-08-08T00:00:05.000Z",
    caller: akumaCaller(sibling.id),
  });
  const unrelated = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110006",
    createdAt: "2026-08-08T00:00:06.000Z",
    caller: { kind: "external", integration: "other", id: "elsewhere" },
    origin: { kind: "fork", parent: direct.id, at: "turn/1" },
  });
  const forked = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110007",
    createdAt: "2026-08-08T00:00:07.000Z",
    origin: { kind: "fork", parent: direct.id, at: "turn/1" },
  });

  const listed = await world.list({ caller: rootCaller });
  const listedRows = listed.rows;
  assert.ok(listedRows !== undefined);
  assert.deepEqual(
    listedRows.map((row) => row.id),
    [delegation.id, greatGrandchild.id, grandchild.id, sibling.id, direct.id],
    "activity order applies after caller and akumaName selection",
  );
  assert.deepEqual(
    listedRows.map((row) => ("parentAkumaId" in row ? row.parentAkumaId : undefined)),
    [sibling.id, grandchild.id, direct.id, undefined, undefined],
    "every born row keeps its frozen caller edge",
  );
  assert.equal(
    listedRows.some((row) => row.id === unrelated.id),
    false,
    "a different caller is not descended",
  );
  assert.equal(
    listedRows.some((row) => row.id === forked.id),
    false,
    "fork origin alone is not a caller edge",
  );

  assert.deepEqual(
    (await world.list({ caller: rootCaller, akumaName: "intern" })).rows?.map((row) => row.id),
    [greatGrandchild.id, grandchild.id],
    "the closure is complete across archetypes before the name filter",
  );
  assert.deepEqual(
    (await world.list({ caller: akumaCaller(direct.id) })).rows?.map((row) => row.id),
    [greatGrandchild.id, grandchild.id],
    "an Akuma caller sees its transitive descendants and not itself",
  );
  assert.deepEqual(
    (await world.list({ caller: akumaCaller(sibling.id) })).rows?.map((row) => row.id),
    [delegation.id],
  );

  const bounded = await world.list({ caller: rootCaller, limit: 2 });
  assert.deepEqual(
    bounded.rows?.map((row) => row.id),
    [delegation.id, greatGrandchild.id],
  );
  assert.equal(bounded.more, true, "the remaining matching members are reported honestly");

  const cache = join(root, ".keiyaku", "akuma", "run", "lineage-cache.sqlite");
  assert.equal(existsSync(cache), true, "the optional lineage cache stays inside this World");
  unlinkSync(cache);
  assert.deepEqual(
    (await world.list({ caller: rootCaller })).rows?.map((row) => row.id),
    listedRows.map((row) => row.id),
    "an unavailable cache falls back to direct Soul reads",
  );
  await assert.rejects(world.list({ caller: { kind: "elsewhere" } } as never), TypeError);
});

test("birth refreshes the World-local caller lineage cache", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-lineage-cache-");
  const world = Akumas.of(await World.at(root));
  const caller = { kind: "external", integration: "test", id: "birth" } as const;
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "ca110010" });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        akumaName: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        cwd: root,
        caller,
      },
      initialBody: "work",
    },
    provider,
    { spawn: noBodyLaunch, now: () => "2026-08-08T00:00:00.000Z" },
  );
  const cache = join(root, ".keiyaku", "akuma", "run", "lineage-cache.sqlite");
  await waitForFile(cache);
  assert.deepEqual(
    (await world.list({ caller })).rows?.map((row) => row.id),
    [allocated.id],
    "the recorded edge answers the caller-scoped query",
  );
  unlinkSync(cache);
  assert.deepEqual(
    (await world.list({ caller })).rows?.map((row) => row.id),
    [allocated.id],
    "the same birth remains discoverable without its cache",
  );
});

test("a wrong lineage cache edge cannot fabricate members or their ancestor chain", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-lineage-tamper-");
  const proved = await World.at(root);
  const world = Akumas.of(proved);
  const rootCaller = { kind: "external", integration: "test", id: "root" } as const;
  const akumaCaller = (akumaId: string): AkumaCaller =>
    ({ kind: "akuma", world: proved, akumaId: akumaId as never }) as AkumaCaller;
  const direct = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110011",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller: rootCaller,
  });
  const descendant = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110012",
    createdAt: "2026-08-08T00:00:02.000Z",
    caller: akumaCaller(direct.id),
  });
  const stranger = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110013",
    createdAt: "2026-08-08T00:00:03.000Z",
    caller: { kind: "external", integration: "other", id: "elsewhere" },
  });
  const strangerChild = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110014",
    createdAt: "2026-08-08T00:00:04.000Z",
    caller: akumaCaller(stranger.id),
  });
  const unborn = await allocateAkumaDirectory({ worldRoot: proved, akumaName: "intern", draw: () => "ca110015" });
  await initializeHeart(unborn.paths);

  // Forged edges: an unrelated worker looks like a direct child, its real child
  // keeps a true edge (so only full-chain verification exposes the forgery), and
  // an unborn identity is given a born caller edge.
  await recordAkumaLineage(proved, { id: stranger.id, caller: rootCaller });
  await recordAkumaLineage(proved, { id: strangerChild.id, caller: akumaCaller(stranger.id) });
  await recordAkumaLineage(proved, { id: unborn.id, caller: rootCaller });

  const listed = await world.list({ caller: rootCaller });
  assert.deepEqual(
    listed.rows?.map((row) => row.id),
    [descendant.id, direct.id],
    "only Soul-proven members survive the forged record",
  );
  assert.deepEqual(
    (await world.list({ caller: rootCaller })).rows?.map((row) => row.id),
    [descendant.id, direct.id],
    "the discarded record is rebuilt from Souls and stays correct",
  );
  assert.deepEqual(
    (await world.list({ caller: akumaCaller(stranger.id) })).rows?.map((row) => row.id),
    [strangerChild.id],
    "the real child remains a child of its real caller",
  );
  assert.deepEqual(
    (await world.list({ caller: rootCaller, akumaName: "intern" })).rows?.map((row) => row.id),
    [descendant.id],
  );
});

test("a lineage cache row for a vanished directory never resurrects an identity", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-lineage-stale-");
  const proved = await World.at(root);
  const world = Akumas.of(proved);
  const rootCaller = { kind: "external", integration: "test", id: "root" } as const;
  const direct = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110016",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller: rootCaller,
  });
  await recordAkumaLineage(proved, { id: "aku/ghost/deadbeef" as never, caller: rootCaller });
  assert.deepEqual(
    (await world.list({ caller: rootCaller })).rows?.map((row) => row.id),
    [direct.id],
  );
  assert.deepEqual(
    (await world.list({ caller: rootCaller })).rows?.map((row) => row.id),
    [direct.id],
    "the vanished identity stays pruned",
  );
});

test("kill returns before its successor recovery settles", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-recovery-fire-and-forget-");
  const { allocated, holder, body } = await bornBody(root, "1d1e0010", "2026-08-10T00:00:00.000Z");
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-10T00:00:01.000Z" });
  await recordTell(allocated.paths, {
    kind: "tell",
    id: "kill-recovery-pending",
    body: "continue",
    recordedAt: "2026-08-10T00:00:02.000Z",
  });
  holder.release();

  let recoveryReleased!: () => void;
  let recoverySettled = false;
  const recovery = new Promise<void>((resolve) => {
    recoveryReleased = () => {
      recoverySettled = true;
      resolve();
    };
  });
  assert.equal(await killAkumaWithRecovery(allocated.paths, async () => await recovery), "killed");
  assert.equal(recoverySettled, false);
  recoveryReleased();
  await recovery;
});

test("failed kill recovery leaves its pending Tell unchanged", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-recovery-failure-");
  const { allocated, holder, body } = await bornBody(root, "1d1e0011", "2026-08-10T00:00:00.000Z");
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-10T00:00:01.000Z" });
  await recordTell(allocated.paths, {
    kind: "tell",
    id: "kill-recovery-failure",
    body: "continue",
    recordedAt: "2026-08-10T00:00:02.000Z",
  });
  holder.release();
  assert.equal(
    await killAkumaWithRecovery(allocated.paths, async () => {
      throw new Error("spawn denied");
    }),
    "killed",
  );
  assert.deepEqual(
    (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
    ["kill-recovery-failure"],
  );
});

test("kill settles a stranded dead Body and later observation presents the killed life", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-stranded-");
  const { allocated, holder, body } = await bornBody(root, "1d1e0012", "2026-08-10T00:00:00.000Z");
  await breakBody(allocated.paths, { sequence: body.sequence, end: "broke-off", at: "2026-08-10T00:00:01.000Z" });
  holder.release();

  const world = Akumas.of(await World.at(root));
  const handle = new AkumaOwner(allocated.id, await World.at(root));
  assert.equal((await handle.status()).life, "stranded");
  assert.equal(await handle.kill(noBodyLaunch), "killed");
  const status = await handle.status();
  assert.equal(status.life, "killed");
  assert.equal("strandedReason" in status, false);
  const listed = (await world.list()).rows?.find((row) => row.id === allocated.id);
  assert.equal(listed !== undefined && "life" in listed && listed.life, "killed");
  assert.equal(await handle.kill(noBodyLaunch), "already-killed");
});

test("interrupt atomically admits its Tell and frontier before predecessor completion", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-idle-");
  const seat = join(root, "seat");
  mkdirSync(seat);
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "1d1e0001" });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        akumaName: "claude",
        provider: CLAUDE_EXECUTION,
        options: {},
        origin: { kind: "direct" },
        cwd: seat,
      },
      initialBody: "first",
    },
    provider,
    { spawn: noBodyLaunch, now: () => "2026-08-08T00:00:00.000Z" },
  );
  rmSync(seat, { recursive: true, force: true });

  const owner = new AkumaOwner(allocated.id, await World.at(root));
  const held = await HeldAkumaLeash.try(allocated.paths);
  assert.ok(held);
  const admission = await owner.admitInterrupt("next", { tellId: "idle-interrupt" });
  assert.equal(admission.kind, "admitted");
  if (admission.kind !== "admitted") throw new Error("interrupt Tell was not admitted");
  const admitted = await readHeart(allocated.paths);
  assert.equal(admitted.pause?.bodySequence, admitted.latestBody?.sequence);
  assert.equal(admitted.pause?.frontierTellId, admission.tell.id);
  assert.deepEqual(
    admitted.pending.map((tell) => tell.id),
    [admission.tell.id],
  );
  held.release();
  const receipt = await owner.completeInterruptAdmission(admission, {
    async spawn() {
      throw new Error("fixture successor unavailable");
    },
  });
  assert.equal(receipt.interruption?.kind, "completed");
  assert.deepEqual(receipt.wake, { kind: "failed", diagnostic: "fixture successor unavailable" });
  assert.equal((await readHeart(allocated.paths)).pause, null);
  assert.deepEqual(
    (await readHeart(allocated.paths)).pending.map((tell) => tell.id),
    [receipt.admission.tellId],
  );
});

test("interrupt completion refuses unexplained successor custody", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-unexplained-successor-");
  const { allocated, holder, body } = await bornBody(root, "1d1e0010", "2026-08-08T00:00:00.000Z");
  let successorLeash: HeldAkumaLeash | null = null;
  try {
    const owner = new AkumaOwner(allocated.id, await World.at(root));
    const admission = await owner.admitInterrupt("protected", {
      tellId: "unexplained-successor-interrupt",
      recordedAt: "2026-08-08T00:00:01.000Z",
    });
    assert.equal(admission.kind, "admitted");
    if (admission.kind !== "admitted") throw new Error("interrupt Tell was not admitted");
    await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: "2026-08-08T00:00:02.000Z" });
    holder.release();

    successorLeash = await HeldAkumaLeash.try(allocated.paths);
    assert.ok(successorLeash);
    await withHeartTransaction(allocated.paths, (heart) => {
      insertBodyFact(heart, { leashTakenAt: "2026-08-08T00:00:03.000Z" });
    });

    const receipt = await owner.completeInterruptAdmission(admission, tellWakeRuntime(noBodyLaunch));
    assert.deepEqual(receipt.interruption, {
      kind: "unavailable",
      bodySequence: body.sequence,
      evidence: "untidy",
    });
    const heart = await readHeart(allocated.paths);
    assert.equal(heart.pause?.frontierTellId, admission.tell.id);
    assert.deepEqual(
      heart.pending.map((tell) => tell.id),
      [admission.tell.id],
    );
  } finally {
    holder.release();
    successorLeash?.release();
  }
});

test("interrupt waits for leash release after a durable Body end beyond the default retry window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-ended-held-"));
  let releaseHolder: (() => void) | undefined;
  let operation: ReturnType<AkumaOwner["interrupt"]> | undefined;
  let restoreTry: (() => void) | undefined;
  try {
    const value = await bornHistoryHandle(root, "1d1e0009");
    releaseHolder = value.holder.release.bind(value.holder);
    await breakBody(value.allocated.paths, {
      sequence: value.turn.bodySequence,
      end: "put-down",
      at: "2026-08-08T00:00:02.000Z",
    });
    const runtime = {
      async spawn(): Promise<LiveBodyLaunch> {
        return {
          completed: Promise.resolve({ diagnostic: "fixture Body completed" }),
          async cancel() {},
          release() {},
        };
      },
    };
    let failedTries = 0;
    let acquireRetryObserved = false;
    const targetLeash = value.allocated.paths.leash.replace(/^\/private/u, "");
    const { promise: retryObserved, resolve: witnessRetry } = promiseBarrier<void>();
    const originalTry = HeldAkumaLeash.try;
    const mockedTry = t.mock.method(HeldAkumaLeash, "try", async (paths: typeof value.allocated.paths) => {
      const leash = await originalTry(paths);
      if (paths.leash.replace(/^\/private/u, "") === targetLeash && leash === null) {
        failedTries += 1;
        if (failedTries === 3) acquireRetryObserved = true;
        if (failedTries === 13) witnessRetry();
      }
      return leash;
    });
    restoreTry = () => mockedTry.mock.restore();
    operation = value.handle.interrupt("after end", { runtime });
    const first = await Promise.race([
      retryObserved.then(() => "retry" as const),
      operation.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
    ]);
    assert.equal(first, "retry", `failed leash tries: ${failedTries}`);
    assert.equal(acquireRetryObserved, true);
    releaseHolder?.();
    releaseHolder = undefined;
    const receipt = await operation;
    assert.equal("kind" in receipt, false);
    if ("kind" in receipt) throw new Error("interrupt was unavailable");
    assert.equal(receipt.interruption?.kind, "completed");
  } finally {
    restoreTry?.();
    releaseHolder?.();
    await operation?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt cancellation after admission stops waiting but keeps Tell and frontier", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-cancelled-"));
  let releaseHolder: (() => void) | undefined;
  try {
    const value = await bornHistoryHandle(root, "1d1e000a");
    releaseHolder = value.holder.release.bind(value.holder);
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");
    const { promise: admitted, resolve: witnessAdmission } =
      promiseBarrier<Awaited<ReturnType<AkumaOwner["admitInterrupt"]>>>();
    const original = AkumaOwner.prototype.admitInterrupt;
    context.mock.method(
      AkumaOwner.prototype,
      "admitInterrupt",
      async function (this: AkumaOwner, body: string, options?: Parameters<AkumaOwner["admitInterrupt"]>[1]) {
        const result = await original.call(this, body, options);
        witnessAdmission(result);
        return result;
      },
    );
    const operation = value.handle.interrupt("cancelled", {
      runtime: tellWakeRuntime(noBodyLaunch),
      tellId: "cancelled-interrupt",
      signal: controller.signal,
    });
    const admission = await admitted;
    assert.equal(admission.kind, "admitted");
    controller.abort(reason);
    await assert.rejects(operation, (error: unknown) => error === reason);
    const heart = await readHeart(value.allocated.paths);
    assert.equal(heart.pause?.frontierTellId, "cancelled-interrupt");
    assert.deepEqual(
      heart.pending.map((tell) => tell.id),
      ["cancelled-interrupt"],
    );
  } finally {
    releaseHolder?.();
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupt preserves an admitted Tell when predecessor custody is untidy", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-unstoppable-");
  const { allocated, holder } = await bornBody(root, "1d1e0003", "2026-08-08T00:00:00.000Z");
  holder.release();
  const receipt = await new AkumaOwner(allocated.id, await World.at(root)).interrupt("never recorded", {
    runtime: tellWakeRuntime(noBodyLaunch), tellId: "untidy-interrupt",
  });
  assert.equal("kind" in receipt, false);
  if ("kind" in receipt) throw new Error("untidy interruption was not admitted");
  assert.equal(receipt.admission.tellId, "untidy-interrupt");
  assert.deepEqual(receipt.interruption, {
    kind: "unavailable",
    bodySequence: (await readHeart(allocated.paths)).latestBody!.sequence,
    evidence: "untidy",
  });
  assert.notEqual(receipt.wake.kind, "failed");
  const heart = await readHeart(allocated.paths);
  assert.equal(heart.pause?.frontierTellId, "untidy-interrupt");
  assert.deepEqual(
    heart.pending.map((tell) => tell.id),
    ["untidy-interrupt"],
  );
});

test("interrupt reports hung when the Body does not release its held leash", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-held-");
  const { allocated, holder, body } = await bornBody(root, "1d1e0005", "2026-08-08T00:00:00.000Z");
  await holder.recordBodyHung(allocated.paths, {
    sequence: body.sequence,
    diagnostic: "provider custody remained live",
    at: "2026-08-08T00:00:01.000Z",
  });
  await breakBody(allocated.paths, {
    sequence: body.sequence,
    end: "broke-off",
    at: "2026-08-08T00:00:02.000Z",
  });
  try {
    const handle = new AkumaOwner(allocated.id, await World.at(root));
    assert.deepEqual(await handle.interrupt("never recorded", { runtime: tellWakeRuntime(noBodyLaunch) }), {
      kind: "unavailable",
      evidence: "hung",
    });
    assert.equal((await handle.status()).life, "hung");
    assert.equal((await readHeart(allocated.paths)).pause, null);
    assert.deepEqual((await readHeart(allocated.paths)).pending, []);
    holder.release();
    assert.deepEqual(await handle.interrupt("still never recorded", { runtime: tellWakeRuntime(noBodyLaunch) }), {
      kind: "unavailable",
      evidence: "hung",
    });
    assert.equal((await handle.status()).life, "hung");
    assert.equal((await readHeart(allocated.paths)).pause, null);
  } finally {
    holder.release();
  }
});

test("kill returns unavailable when an unsettled Body keeps the leash", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-kill-held-"));
  const value = await bornHistoryHandle(root, "1d1e0008");
  try {
    const started = performance.now();
    assert.equal(await value.handle.kill(noBodyLaunch), "unavailable");
    assert.ok(performance.now() - started < 3_000);
  } finally {
    value.holder.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Project Archetype definitions shadow Home while Home remains the fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-project-archetypes-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-project-archetypes-home-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akumas"), { recursive: true });
    mkdirSync(join(home, "akumas"));
    writeFileSync(join(root, ".keiyaku", "akumas", "project-only.md"), "---\nprovider: claude\n---\nProject only.\n");
    writeFileSync(join(home, "akumas", "home-only.md"), "---\nprovider: claude\n---\nHome only.\n");
    writeFileSync(
      join(root, ".keiyaku", "akumas", "shared.md"),
      "---\nprovider: claude\ndescription: Project\n---\nProject body.\n",
    );
    writeFileSync(join(home, "akumas", "shared.md"), "---\nprovider: claude\ndescription: Home\n---\nHome body.\n");

    const settingsValue = await settings({ root, home });
    const catalog = await listArchetypeDefinitions({ project: root, home });
    assert.deepEqual(catalog, {
      kind: "archetype-catalogue",
      rows: [{ name: "home-only" }, { name: "project-only" }, { name: "shared", description: "Project" }],
    });

    const cli = await cliJson<Readonly<{ rows?: readonly unknown[]; more?: true }>>(
      ["-C", root, "ls", "aku/"],
      { environment: { KEIYAKU_HOME: home } },
    );
    assert.deepEqual(cli.value, catalog);

    const shared = await loadPreparedArchetype({ name: "shared", project: root, home, settings: settingsValue });
    assert.equal(shared.path, join(root, ".keiyaku", "akumas", "shared.md"));
    assert.equal(shared.description, "Project");
    const fallback = await loadPreparedArchetype({ name: "home-only", project: root, home, settings: settingsValue });
    assert.equal(fallback.path, join(home, "akumas", "home-only.md"));

    await assert.rejects(
      loadPreparedArchetype({ name: "missing", project: root, home, settings: settingsValue }),
      (error: unknown) =>
        error instanceof AkumaArchetypeError &&
        error.searched.join("\n") ===
          [join(root, ".keiyaku", "akumas", "missing.md"), join(home, "akumas", "missing.md")].join("\n"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("dotted akumaName file stems join the catalogue as canonical names", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-dotted-root-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-dotted-home-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akumas"), { recursive: true });
    mkdirSync(join(home, "akumas"));
    writeFileSync(join(home, "akumas", "review.v2.md"), "---\nprovider: claude\n---\nDotted.\n");
    writeFileSync(join(home, "akumas", "bad..stem.md"), "---\nprovider: claude\n---\nNot canonical.\n");
    writeFileSync(join(home, "akumas", ".edge.md"), "---\nprovider: claude\n---\nNot canonical.\n");

    const catalog = await listArchetypeDefinitions({ project: root, home });
    assert.deepEqual(catalog, { kind: "archetype-catalogue", rows: [{ name: "review.v2" }] });

    const settingsValue = await settings({ root, home });
    const dotted = await loadPreparedArchetype({ name: "review.v2", project: root, home, settings: settingsValue });
    assert.equal(dotted.path, join(home, "akumas", "review.v2.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("hidden archetypes stay callable but leave the catalogue", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-hidden-root-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-hidden-home-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akumas"), { recursive: true });
    mkdirSync(join(home, "akumas"));
    writeFileSync(join(home, "akumas", "visible.md"), "---\nprovider: claude\n---\nVisible.\n");
    writeFileSync(join(home, "akumas", "secret.md"), "---\nprovider: claude\nhidden: true\n---\nSecret.\n");
    writeFileSync(join(home, "akumas", "child.md"), "---\nbase: secret\n---\nChild of a hidden base.\n");

    const catalog = await listArchetypeDefinitions({ project: root, home });
    assert.deepEqual(catalog, { kind: "archetype-catalogue", rows: [{ name: "child" }, { name: "visible" }] });
    assert.deepEqual(await listArchetypeDefinitions({ project: root, home, limit: 1 }), {
      kind: "archetype-catalogue",
      rows: [{ name: "child" }],
      more: true,
    });

    const settingsValue = await settings({ root, home });
    const hidden = await loadPreparedArchetype({ name: "secret", project: root, home, settings: settingsValue });
    assert.equal(hidden.path, join(home, "akumas", "secret.md"));

    writeFileSync(join(home, "akumas", "broken.md"), '---\nprovider: claude\nhidden: "true"\n---\n');
    await assert.rejects(listArchetypeDefinitions({ project: root, home }), /hidden must be a boolean/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("list omits unreadable Hearts instead of reporting unborn, while direct status fails", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-list-schema-cut-");
  const heartCut = await allocateAkumaDirectory({
    worldRoot: root,
    akumaName: "claude",
    draw: () => "c1000001",
  });
  seedLegacySchema(heartCut.paths.heart, "akuma_schema", 13);
  const noise = join(akumaRunRoot(root), "NOISE-notid");
  mkdirSync(noise);
  const visible = await allocateAkumaDirectory({
    worldRoot: root,
    akumaName: "claude",
    draw: () => "c1000003",
  });

  const world = Akumas.of(await World.at(root));
  await assert.rejects(
    new AkumaOwner(heartCut.id, await World.at(root)).status(),
    (error: unknown) => !(error instanceof AkumaNotBornError),
  );
  assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
  assert.equal(existsSync(noise), true);

  rmSync(heartCut.paths.directory, { recursive: true, force: true });
  const leashCut = await allocateAkumaDirectory({
    worldRoot: root,
    akumaName: "claude",
    draw: () => "c1000002",
  });
  await initializeHeart(leashCut.paths);
  unlinkSync(leashCut.paths.leash);
  assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
});

test("kill gives the Body a grace window to abort its owned provider session", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-");
  const allocated = await allocateAkumaDirectory({ worldRoot: root, akumaName: "claude", draw: () => "fedcba98" });
  await initializeHeart(allocated.paths);
  let aborted = false;
  const { promise: completion, resolve: settle } = promiseBarrier<{ kind: "failed"; diagnostic: string }>();
  const { promise: started, resolve: markStarted } = promiseBarrier<void>();
  const running: ProviderAdapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    const abort = async () => {
      aborted = true;
      settle({ kind: "failed", diagnostic: "stopped" });
    };
    custody.own({ closed: completion.then(() => undefined), abort, forceDispose: abort });
    return {
      admission: { fence: "kill-fixture-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          markStarted();
          while (!aborted) {
            yield { type: "note" as const, text: "Working" };
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        },
      },
      completion,
    };
  }));
  const launch: BodyLaunch = {
    paths: allocated.paths,
    seed: {
      id: allocated.id,
      akumaName: "claude",
      provider: CLAUDE_EXECUTION,
      options: {},
      origin: { kind: "direct" },
      cwd: root,
    },
    initialBody: "keep working",
  };
  const body = driveAkumaBody(launch, running, { spawn: noBodyLaunch, now: () => "2026-08-08T00:00:00.000Z" });
  await started;

  const handle = new AkumaOwner(allocated.id, await World.at(root));
  const waited = handle.wait();
  assert.equal(await handle.kill(noBodyLaunch), "killed");
  await body;
  assert.notEqual((await waited).life, "running");
  assert.equal(aborted, true);
  assert.equal((await readHeart(allocated.paths)).latestBody?.end, "put-down");
  assert.equal((await handle.status()).life, "killed");
});
