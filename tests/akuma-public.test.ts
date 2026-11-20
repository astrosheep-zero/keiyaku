import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { answering, fixtureAdapter, fixtureLauncher, settleFixtureBodies } from "./support/akuma-tell.js";
import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import { waitForCondition } from "./support/process.js";
import {
  activityFact,
  allocatedHeart,
  bornBody,
  bornLineageAkuma,
  claudeBodyLaunch,
  driveWithTell,
  seedLegacySchema,
  turnEndFact,
} from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { waitForFixtureFile as waitForFile } from "./support/process.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AkumaNotBornError } from "../src/akuma/akuma-errors.js";
import type { AkumaCaller } from "../src/akuma/caller.js";
import { projectFact, type ActivityHistory } from "../src/akuma/projection.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { driveAkumaBody, tellWakeRuntime } from "../src/akuma/body.js";
import type { BodyLaunch, BodyLauncher } from "../src/akuma/body-launch.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import {
  activitySlice,
  appendActivity,
  beginTurn,
  bindTellsToTurn,
  breakBody,
  endTurn,
  finishBodyIfIdle,
  HeldAkumaLeash,
  probeLeash,
  readHeart,
  readTell,
  readTurn,
  recordTell,
  recordTellDeliveries,
  type TimelineFact,
} from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, parseAkumaId, pathsForAkumaId } from "../src/akuma/identity.js";
import { createProviderAttempt, type DriveInput, type ProviderAdapter } from "../src/akuma/provider.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { Akumas, KeiyakuError } from "../src/index.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { World, type WorldRoot } from "../src/world.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

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

test("compact activity ids recover retained input, tool phases and narration through CLI", async (context) => {
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
    assert.equal(rawStart.stdout, `run $ ${command.trim()}`);
    const nativePage = historyPage(await owner.history());
    const composedStatus = await api.status({ akuma: born.allocated.id });
    assert.deepEqual(observed.value, composedStatus);
    assert.deepEqual(composedStatus.recent, nativePage.rows);
    assert.deepEqual((await owner.status()).recent, nativePage.rows);
    const composedPage = await api.history({ akuma: born.allocated.id });
    assert.ok(composedPage.kind === "akuma");
    assert.deepEqual(composedPage.events, nativePage.rows);
    const pageJson = await cliJson(["history", born.allocated.id], { cwd: root });
    assert.deepEqual(pageJson.value, composedPage);
    const pageText = await runCli(["history", born.allocated.id], { cwd: root });
    assert.match(pageText.stdout, /\? run \(bash\).*\n +\$ npm test .*…/u);
    assert.equal(nativePage.rows[0]?.id, turn.sequence);
    assert.equal(nativePage.rows[0]?.text, "", "opening Turn still counts but is not visible or openable");
    const callEntry = nativePage.rows.find(row => row.text.startsWith("▸"));
    assert.ok(callEntry);
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(callEntry.id)], { cwd: root })).stdout, `call: ${call}`);

    const done = await appendActivity(born.allocated.paths, {
      turnSequence: turn.sequence, at: "2026-08-10T00:00:03.000Z",
      event: { type: "tool", phase: "completed", id: "native-run", name: "bash", call: { kind: "run", command }, result: { status: "error", exitCode: 7, output: "retained output", message: "test failed" } },
    });
    const displaced = await api.history({ akuma: born.allocated.id, id: String(active.id) });
    assert.ok(displaced.kind === "akuma-activity" && displaced.row.kind === "tool");
    assert.equal(displaced.row.sequence, start);
    assert.equal(displaced.row.phase, "started");
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(start)], { cwd: root })).stdout, `run $ ${command.trim()}`);
    const settled = await cliJson<Awaited<ReturnType<typeof api.history>>>(["history", born.allocated.id, "--id", String(done)], { cwd: root });
    assert.ok(settled.value.kind === "akuma-activity" && settled.value.row.kind === "tool");
    assert.equal(settled.value.row.sequence, done);
    assert.equal(settled.value.row.phase, "completed");
    assert.equal(settled.value.row.toolId, displaced.row.toolId);
    assert.equal(settled.value.row.turnSequence, displaced.row.turnSequence);
    assert.deepEqual(settled.value.row.result, { status: "error", exitCode: 7, output: "retained output", message: "test failed" });
    const beforeDone = historyPage(await owner.history({ before: done, limit: 1 }));
    const sinceStart = historyPage(await owner.history({ since: start }));
    assert.deepEqual(beforeDone.rows, nativePage.rows.slice(-1));
    assert.equal(beforeDone.omitted, 2);
    assert.equal(beforeDone.hasEarlier, true);
    assert.deepEqual(sinceStart.rows.map(row => row.id), [done]);
    assert.equal(sinceStart.lowestRetained, turn.sequence);
    assert.equal(sinceStart.highest, done);
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
    const page = historyPage(await owner.history());
    assert.ok(page.rows.some(row => row.id === said && row.text.startsWith("▎")));
    assert.ok(page.rows.at(-1)?.text.startsWith(`✓ turn/${turn.sequence}\n`));
    const rawSaid = await runCli(["history", born.allocated.id, "--id", String(said)], { cwd: root });
    assert.equal(rawSaid.stdout, `said: ${answer}`);
    assert.equal((await runCli(["history", born.allocated.id, "--answer"], { cwd: root })).stdout, answer);
    assert.equal((await runCli(["history", born.allocated.id, "--id", `turn/${turn.sequence}`], { cwd: root })).stdout, answer);
    assert.deepEqual(await owner.fork({ at: String(said) }, noBodyLaunch), { kind: "unknown-history" });
    assert.equal((await api.history({ akuma: born.allocated.id, id: String(turn.sequence) })).kind, "akuma-unknown-history");
    assert.equal((await api.history({ akuma: born.allocated.id, id: "999999" })).kind, "akuma-unknown-history");
    const idle = await recordTell(born.allocated.paths, { kind: "tell", id: "idle-pending", body: tellText, recordedAt: "2026-08-10T00:00:08.000Z" });
    assert.equal(idle.kind, "recorded");
    const idleStatus = await api.status({ akuma: born.allocated.id });
    const idlePending = idleStatus.work.pending?.[0];
    assert.ok(idlePending && idleStatus.work.kind === "idle" && idleStatus.work.outcome?.state === "done");
    assert.equal((await runCli(["history", born.allocated.id, "--id", String(idlePending.id)], { cwd: root })).stdout, `pending-tell: ${tellText}`);
    assert.deepEqual((await owner.status()).work, idleStatus.work);
  } finally { born.holder.release(); }
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
      const roster = await Akumas.of(await World.at(root)).list({ selection: "all" });
      const result =
        observation === "roster"
          ? roster.rows?.find((row) => row.id === value.allocated.id)
          : observation === "wait"
            ? await value.handle.wait({ timeoutMs: 1_000 })
            : await value.handle.status();
      assert.equal(finished, true);
      assert.ok(result);
      if ("state" in result) {
        assert.ok(result.state === "done");
        assert.equal(result.turn, `turn/${value.turn.sequence}`);
        assert.equal(result.at, "2026-08-12T00:05:00.000Z");
      } else {
        assert.equal(result.life, "asleep");
        if ("lifeAt" in result) assert.equal(result.lifeAt, "2026-08-12T00:05:00.000Z");
        if ("work" in result) {
          assert.equal(result.work.kind, "idle");
          assert.equal(result.work.outcome?.state, "done");
        }
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
    const allocated = await allocatedHeart(world, "claude", "deadbeef");
    driving = driveWithTell(claudeBodyLaunch(allocated, world), "work", rejecting, {
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
  const allocated = await allocatedHeart(world, "claude", suffix);
  await driveWithTell(
    claudeBodyLaunch(allocated, world, {}, {
      description: "Fork source",
      ...(bare === undefined ? {} : { bare }),
      options: { model: "fixture-model" },
    }),
    "work",
    provider,
    { now: () => "2026-08-08T00:00:00.000Z" },
  );
  return allocated;
}

type MutableProvider = {
  -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] | undefined;
};

test("identical final narration and exact answer retain independent identities", () => {
  const at = "2026-10-15T00:00:00.000Z";
  const facts: TimelineFact[] = [
    { kind: "turn-start", sequence: 1, bodySequence: 1, startedAt: at },
    activityFact(2, 1, at, { type: "assistant", text: "same answer" }),
    activityFact(3, 1, at, { type: "assistant", text: "same answer" }),
    turnEndFact(4, 1, at, { kind: "answered", answer: "same answer", session: { sessionId: "session" } }),
  ];
  const rows = facts.map(projectFact);
  assert.deepEqual(rows.map(row => [row.kind, row.sequence]), [
    ["turn", 1], ["said", 2], ["said", 3], ["outcome", 4],
  ]);
  const outcome = rows.at(-1);
  assert.ok(outcome?.kind === "outcome" && outcome.outcome.kind === "answered");
  assert.equal(outcome.outcome.answer, "same answer");
});

test("wait timeout returns compact running evidence and its exact retained outcome", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-wait-timeout-");
  const source = await answeredSource(root, "de1ad100");
  const leash = (await HeldAkumaLeash.try(source.paths))!;
  try {
    const handle = new AkumaOwner(source.id, await World.at(root));
    const status = await handle.status();
    const last = { turn: "turn/2", state: "done", at: "2026-08-08T00:00:00.000Z", answer: "public answer" };
    assert.equal(status.life, "running");
    assert.deepEqual(status.work.outcome, last);
    assert.deepEqual(await handle.wait({ timeoutMs: 0 }), {
      akuma: source.id, state: "running", lastActivityAt: status.lastActivityAt, last,
    });
  } finally {
    leash.release();
  }
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
      at: "turn/2",
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
    assert.deepEqual(status.birth, { origin: { kind: "fork", parent: source.id, at: "turn/2" }, caller });
    await waitForCondition(
      `the exact fork child ${receipt.childAkumaId} akuma.born line in ${output}`,
      () => readFileSync(output, "utf8")
        .split("\n")
        .some((line) => {
          if (line.length === 0) return false;
          try {
            const signal = JSON.parse(line) as { kind?: unknown; akumaId?: unknown };
            return signal.kind === "akuma.born" && signal.akumaId === receipt.childAkumaId;
          } catch {
            return false;
          }
        }),
    );
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
    const inherited = await Akumas.of(world).fork({ akuma: bareSource.id, at: "turn/2", bare: false });
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
      const body = driveAkumaBody(launch, provider, { world });
      bodies.push(body);
      return { completed: body.then(() => ({ diagnostic: "fork launch completed" })), async cancel() {}, release() {} };
    };
    const second = await akumasWithLauncher(world, spawn).fork({
      akuma: source.id,
      at: "turn/2",
      caller,
    });
    await Promise.all(bodies);
    assert.equal(second.kind, "forked");
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.birthSession?.coordinate.sessionId, "native-fork");
    assert.deepEqual(launches[0]?.seed?.origin, { kind: "fork", parent: source.id, at: "turn/2" });
    assert.equal((await readHeart(launches[0]!.paths)).latestBody?.end, "exited");
  } finally {
    mutable.fork = original;
  }
});

test("public Akuma handles separate compact list rows from full status and wait", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-public-");
  const world = Akumas.of(await World.at(root));
  const empty = await world.list();
  assert.equal(empty.rows, undefined, "an empty roster omits rows");
  assert.equal(empty.more, undefined, "a complete roster omits more");
  const allocated = await allocatedHeart(root, "claude", "1234abcd");
  await moveAlias({ world: root as WorldRoot, alias: parseAkumaAlias("@early"), akumaId: allocated.id });
  const unbornRows = (await world.list()).rows;
  assert.ok(unbornRows !== undefined);
  assert.equal(unbornRows[0]?.life, "unborn");
  assert.deepEqual(unbornRows[0]?.aliases, ["@early"]);
  assert.equal((await world.list({ akumaName: "claude" })).rows?.[0]?.id, allocated.id);
  assert.equal((await world.list({ akumaName: "reviewer" })).rows, undefined);
  await assert.rejects(world.list({ akumaName: "not/a-name" }), /Akuma name/);
  await assert.rejects(world.list({ unknown: true } as never), /unknown field: unknown/);

  const launch = claudeBodyLaunch(allocated, root, {}, {
    description: "Fixture akuma",
  });
  await driveWithTell(launch, "work", provider, { now: () => "2026-08-08T00:00:00.000Z" });

  const handle = new AkumaOwner(allocated.id, await World.at(root));
  assert.equal((await world.list()).rows, undefined, "asleep instances leave the default active catalogue");
  const listedRows = (await world.list({ selection: "settled" })).rows;
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
  assert.equal(status.work.kind, "idle");
  assert.equal(status.work.outcome?.state, "done");
  assert.equal(status.work.turn?.sequence, 2);
  assert.equal("history" in status, false);
  assert.match(historyPage(await handle.history()).rows.at(-1)?.text ?? "", /✓ turn\/2\n +public answer/u);
  const exact = await handle.history({ id: "turn/2" });
  if (!("kind" in exact) || exact.kind !== "exact") throw new Error("expected exact history");
  assert.deepEqual(exact.outcome, { turn: "turn/2", state: "done", at: "2026-08-08T00:00:00.000Z", answer: "public answer" });
  assert.deepEqual(status.work.outcome, exact.outcome);
  assert.ok((status.recent?.length ?? 0) <= 3);
  const { akuma, lastActivityAt, ...waited } = await handle.wait();
  assert.equal(akuma, status.id);
  assert.equal(lastActivityAt, status.lastActivityAt);
  assert.deepEqual(waited, exact.outcome);
  assert.equal(await handle.kill(), "already-stopped");
  assert.equal((await handle.status()).life, "asleep");
  const finalStatus = await handle.status();
  assert.deepEqual(finalStatus.work.outcome, exact.outcome);
  assert.equal(await handle.kill(), "already-stopped");
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

  const listed = await world.list({ caller: rootCaller, selection: "all" });
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
    (await world.list({ caller: rootCaller, akumaName: "intern", selection: "all" })).rows?.map((row) => row.id),
    [greatGrandchild.id, grandchild.id],
    "the closure is complete across archetypes before the name filter",
  );
  assert.deepEqual(
    (await world.list({ caller: akumaCaller(direct.id), selection: "all" })).rows?.map((row) => row.id),
    [greatGrandchild.id, grandchild.id],
    "an Akuma caller sees its transitive descendants and not itself",
  );
  assert.deepEqual(
    (await world.list({ caller: akumaCaller(sibling.id), selection: "all" })).rows?.map((row) => row.id),
    [delegation.id],
  );

  const bounded = await world.list({ caller: rootCaller, selection: "all", limit: 2 });
  assert.deepEqual(
    bounded.rows?.map((row) => row.id),
    [delegation.id, greatGrandchild.id],
  );
  assert.equal(bounded.more, true, "the remaining matching members are reported honestly");

  // A fresh file timestamp is not semantic recency: every readable Heart is
  // observed and its retained evidence decides the order.
  const ahead = new Date("2030-01-01T00:00:00.000Z");
  const behind = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(direct.paths.heart, ahead, ahead);
  utimesSync(delegation.paths.heart, behind, behind);
  assert.deepEqual(
    (await world.list({ caller: rootCaller, selection: "all" })).rows?.map((row) => row.id),
    listedRows.map((row) => row.id),
    "misleading file timestamps do not reorder semantic activity",
  );

  const cache = join(root, ".keiyaku", "akuma", "run", "lineage-cache.sqlite");
  assert.equal(existsSync(cache), false, "caller selection keeps no ancestry record beside Heart custody");
  assert.deepEqual(
    (await world.list({ caller: rootCaller, selection: "all" })).rows?.map((row) => row.id),
    listedRows.map((row) => row.id),
    "the same frozen Souls answer every caller-scoped observation",
  );
  await assert.rejects(
    world.list({ caller: { kind: "elsewhere" } } as never),
    (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input",
  );
});

test("an unreadable ancestor Soul leaves only its readable peers proven", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-lineage-unreadable-");
  const proved = await World.at(root);
  const world = Akumas.of(proved);
  const caller = { kind: "external", integration: "test", id: "root" } as const;
  const akumaCaller = (akumaId: string): AkumaCaller =>
    ({ kind: "akuma", world: proved, akumaId: akumaId as never }) as AkumaCaller;
  const direct = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110016",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller,
  });
  const sibling = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110017",
    createdAt: "2026-08-08T00:00:02.000Z",
    caller,
  });
  const grandchild = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110018",
    createdAt: "2026-08-08T00:00:03.000Z",
    caller: akumaCaller(direct.id),
  });
  const heart = new DatabaseSync(direct.paths.heart);
  const original = heart.prepare("SELECT soul_json FROM soul").get()!.soul_json as string;
  try {
    heart.prepare("UPDATE soul SET soul_json = ?").run("{}");
  } finally {
    heart.close();
  }
  const incomplete = await world.list({ caller, selection: "all" });
  assert.deepEqual(
    incomplete.rows?.map((row) => row.id),
    [sibling.id],
    "a readable downstream edge cannot bridge the unreadable Soul above it",
  );
  assert.equal(incomplete.more, true, "an unreadable recognized Soul leaves the extent uncertain");
  assert.equal((await world.list({ caller, akumaName: "worker", selection: "all" })).rows, undefined);
  const restore = new DatabaseSync(direct.paths.heart);
  try {
    restore.prepare("UPDATE soul SET soul_json = ?").run(original);
  } finally {
    restore.close();
  }
  assert.deepEqual(
    (await world.list({ caller, selection: "all" })).rows?.map((row) => row.id),
    [grandchild.id, sibling.id, direct.id],
    "restored Soul evidence proves the whole tree without a repair write",
  );
});

test("a member reclaimed between Soul and lifecycle reads is omitted with uncertain extent", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-lineage-reclaimed-");
  const proved = await World.at(root);
  const world = Akumas.of(proved);
  const caller = { kind: "external", integration: "test", id: "reclaimed" } as const;
  const akumaCaller = (akumaId: string): AkumaCaller =>
    ({ kind: "akuma", world: proved, akumaId: akumaId as never }) as AkumaCaller;
  const parent = await bornLineageAkuma({
    root,
    akumaName: "worker",
    draw: "ca110021",
    createdAt: "2026-08-08T00:00:01.000Z",
    caller,
  });
  const child = await bornLineageAkuma({
    root,
    akumaName: "intern",
    draw: "ca110022",
    createdAt: "2026-08-08T00:00:02.000Z",
    caller: akumaCaller(parent.id),
  });
  const prepare = DatabaseSync.prototype.prepare;
  let reclaimed = false;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (!sql.includes("FROM soul WHERE singleton = 1")) return statement;
    const get = statement.get.bind(statement);
    statement.get = ((...args: Parameters<typeof get>) => {
      const row = get(...args) as { soul_json?: unknown } | undefined;
      if (!reclaimed && typeof row?.soul_json === "string" && row.soul_json.includes(parent.id)) {
        reclaimed = true;
        // Its frozen Soul proved the edge; the Heart is reclaimed before the
        // lifecycle observation reads it.
        for (const file of [parent.paths.heart, `${parent.paths.heart}-wal`, `${parent.paths.heart}-shm`]) {
          rmSync(file, { force: true });
        }
      }
      return row;
    }) as typeof statement.get;
    return statement;
  };
  try {
    const listed = await world.list({ caller, selection: "all" });
    assert.equal(reclaimed, true, "the fixture reclaimed the member after its frozen Soul read");
    assert.deepEqual(
      listed.rows?.map((row) => row.id),
      [child.id],
      "the reclaimed member is omitted, not returned as unborn, and its proven descendant remains",
    );
    assert.equal(listed.more, true, "the vanished member leaves the observed extent uncertain");
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
});

test("ordinary Tell wakes a successor for a barrier-free untidy Akuma", async (context) => {
  const world = await World.at(temporaryDirectory(context, "keiyaku-akuma-tell-untidy-"));
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const at = "2026-08-10T00:00:00.000Z";
  const { allocated: { id, paths }, holder, body } = await bornBody(world, "1d1e0013", at);
  const retained = { id: "bound-before-loss", text: "continue the original work" };
  const initiator = "original-tell-owner";
  let oldTurn;
  try {
    oldTurn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    await recordTell(paths, { kind: "tell", id: retained.id, body: retained.text, initiator, recordedAt: at });
    await bindTellsToTurn(paths, { turnSequence: oldTurn.sequence, tellIds: [retained.id], boundAt: at });
  } finally {
    holder.release();
  }
  const pending = await readTell(paths, retained.id);
  assert.ok(pending);
  assert.equal(pending.state, "pending");
  assert.deepEqual(pending.binding, { turnSequence: oldTurn.sequence, boundAt: at });
  assert.deepEqual(pending.deliveries, []);

  const submissions: DriveInput["launchTells"][] = [];
  const bodies: Promise<unknown>[] = [];
  const provider = answering("successor answer");
  const adapter = fixtureAdapter((input) => {
    submissions.push(input.launchTells);
    return provider.start(input);
  });
  const successorAt = "2026-08-10T00:00:01.000Z";
  const spawn = fixtureLauncher(bodies, new Map([[paths.directory, { adapter, now: successorAt }]]));
  const api = akumasWithLauncher(world, spawn);
  const text = "also take this next instruction";
  try {
    assert.equal((await api.status({ akuma: id })).life, "untidy");
    const receipt = await api.tell({ akuma: id, body: text });
    assert.ok("result" in receipt && receipt.result === "told", JSON.stringify(receipt));
    await Promise.all(bodies);
    const { latestBody: successor, latestKill } = await readHeart(paths);
    assert.ok(successor && successor.sequence > body.sequence);
    const fresh = await readTell(paths, receipt.tellId);
    assert.ok(fresh?.binding);
    const { turnSequence } = fresh.binding;
    assert.equal((await readTurn(paths, turnSequence))?.bodySequence, successor.sequence);
    if (receipt.turn !== undefined) assert.equal(receipt.turn, `turn/${turnSequence}`);
    const delivery = { turnSequence, route: "launch", deliveredAt: successorAt };
    assert.deepEqual(fresh.deliveries, [delivery]);
    assert.deepEqual(submissions, [[retained, { id: receipt.tellId, text }]]);
    assert.deepEqual(await readTell(paths, retained.id), {
      ...pending,
      state: "told",
      binding: { turnSequence, boundAt: successorAt },
      deliveries: [delivery],
    });
    assert.deepEqual(await readTurn(paths, oldTurn.sequence), oldTurn);
    assert.equal(latestKill, null);
  } finally {
    await settleFixtureBodies(bodies);
  }
});

test("kill settles a stranded dead Body and later observation presents the killed life", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-kill-stranded-");
  const { allocated, holder, body } = await bornBody(root, "1d1e0012", "2026-08-10T00:00:00.000Z");
  await breakBody(allocated.paths, { sequence: body.sequence, end: "broke-off", at: "2026-08-10T00:00:01.000Z" });
  holder.release();

  const world = Akumas.of(await World.at(root));
  const handle = new AkumaOwner(allocated.id, await World.at(root));
  assert.equal((await handle.status()).life, "stranded");
  assert.equal(await handle.kill(), "killed");
  const status = await handle.status();
  assert.equal(status.life, "killed");
  assert.equal("strandedReason" in status, false);
  assert.equal((await world.list()).rows, undefined, "killed instances are settled");
  const listed = (await world.list({ selection: "settled" })).rows?.find((row) => row.id === allocated.id);
  assert.equal(listed !== undefined && "life" in listed && listed.life, "killed");
  assert.equal(await handle.kill(), "already-killed");
});

test("interrupt atomically admits its Tell and frontier before predecessor completion", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-interrupt-idle-");
  const seat = join(root, "seat");
  mkdirSync(seat);
  const allocated = await allocatedHeart(root, "claude", "1d1e0001");
  await driveWithTell(
    claudeBodyLaunch(allocated, seat),
    "first",
    provider,
    { now: () => "2026-08-08T00:00:00.000Z" },
  );

  const owner = new AkumaOwner(allocated.id, await World.at(root));
  const held = await HeldAkumaLeash.try(allocated.paths);
  assert.ok(held);
  const admission = await owner.admitTell("next", { tellId: "idle-interrupt", interrupt: true });
  assert.equal(admission.kind, "recorded");
  if (admission.kind !== "recorded") throw new Error("interrupt Tell was not admitted");
  const admitted = await readHeart(allocated.paths);
  assert.equal(admitted.pause?.bodySequence, admitted.latestBody?.sequence);
  assert.equal(admitted.pause?.frontierTellId, admission.tell.id);
  assert.deepEqual(
    admitted.pending.map((tell) => tell.id),
    [admission.tell.id],
  );
  held.release();
  const receipt = await owner.settleTell(admission, {
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

test("interrupt cancellation after admission stops waiting but keeps Tell and frontier", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-interrupt-cancelled-"));
  let releaseHolder: (() => void) | undefined;
  try {
    const value = await bornHistoryHandle(root, "1d1e000a");
    releaseHolder = value.holder.release.bind(value.holder);
    const controller = new AbortController();
    const reason = new Error("caller stopped waiting");
    const { promise: admitted, resolve: witnessAdmission } =
      promiseBarrier<Awaited<ReturnType<AkumaOwner["admitTell"]>>>();
    const original = AkumaOwner.prototype.admitTell;
    context.mock.method(
      AkumaOwner.prototype,
      "admitTell",
      async function (this: AkumaOwner, body: string, options?: Parameters<AkumaOwner["admitTell"]>[1]) {
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
    assert.equal(admission.kind, "recorded");
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
  const leashCut = await allocatedHeart(root, "claude", "c1000002");
  unlinkSync(leashCut.paths.leash);
  assert.deepEqual((await world.list()).rows, [{ id: visible.id, life: "unborn" }]);
});
