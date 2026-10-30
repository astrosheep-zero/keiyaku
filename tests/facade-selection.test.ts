import { akumasWithLauncher } from "../src/library/akumas.js";
import { localExecutionContext } from "../src/akuma/requests.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { accepted, present } from "./support/library-verbs.js";
import { boundedListLimit, projectBoundedList } from "../src/bounded-list.js";
import { listArchetypeDefinitions } from "../src/index.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import {
  constants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { boundedMap, PAGE_POOL_SIZE } from "../src/akuma/read-pool.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { activitySlice, appendActivity, beginTurn, breakBody, endTurn, HeldAkumaLeash, initializeHeart, recordTell } from "../src/akuma/heart/index.js";
import { akuId, allocateAkumaDirectory, type AkuId } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { moveAlias, readAliases } from "../src/alias/index.js";
import { contractId, contractSegment } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { AkumaWorldScopeError, Akumas, Keiyaku, Repo, type WorldRoot } from "../src/index.js";
import { observeKanshi } from "../src/kanshi/read.js";
import { addressAkumaSet, observeNamedAddress, resolveNamedAddress } from "../src/library/address.js";
import { createLiveStatusReader, defaultWaitComplete } from "../src/akuma/akuma-observe.js";
import { executeWaitAkuma } from "../src/akuma/akuma-wait.js";
import { projectDebtBoardObservation } from "../src/debt/board.js";
import { serializeDebtDocument, type DebtDocument } from "../src/debt/document.js";
import { Debts, type DebtId } from "../src/debt/index.js";
import { readBoard } from "../src/debt/store.js";
import { World } from "../src/world.js";
import { AkumaComposition as Akuma } from "./support/akuma-composition.js";
import { bornBody, bornDirectAkuma } from "./support/akuma-fixtures.js";
import { Akuma as NativeAkuma } from "../src/akuma/index.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { bodyRequestExecution } from "../src/akuma/requests.js";
import { selectionRequestCommands } from "../src/akuma/selection-request.js";
import { selectionRequestPort } from "../src/akuma/selection-owner-port.js";
import { akumasWithExecution } from "../src/library/akumas.js";
import { finishBodyIfIdle } from "../src/akuma/heart/index.js";
import {
  answering,
  bornWorld,
  fixtureAdapter,
  fixtureLauncher,
  settleFixtureBodies,
} from "./support/akuma-tell.js";
import { Schema } from "../src/akuma/index.js";
import { makeGitRepository, withGitShim } from "./support/git.js";
import {
  debtAuthorityFile,
  debtDocument as creatorDebt,
  writeDebtAuthority as writeCreatorDebt,
} from "./support/debt.js";

let fixtureHistory = 0;

function fixtureSession(input: Readonly<{ signal: AbortSignal }>) {
  return createProviderAttempt(input.signal, async (custody) => {
    const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
    const completion = eventsFinished.then(() => ({
      kind: "answered" as const,
      answer: "done",
      historyId: `roster-history-${fixtureHistory++}`,
    }));
    const session = {
      admission: { fence: "roster-fixture-turn" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "fixture" } };
          finishEvents();
        },
      },
      completion,
    };
    custody.own({
      closed: completion.then(() => undefined),
      abort: async () => {},
      forceDispose: async () => {},
    });
    return session;
  });
}

const provider: ProviderAdapter = {
  admitOptions(options) {
    return { kind: "admitted", options };
  },
  start: fixtureSession,
  resume: fixtureSession,
};

function fixtureRoot(t: TestContext, prefix: string): WorldRoot {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))) as WorldRoot;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// The template is a closed, unborn database pair: no Soul or identity-bound facts.
// Copy bytes, never hard-link them, so every catalog member keeps independent custody.
async function initializeUnbornFixture(
  paths: Parameters<typeof initializeHeart>[0],
  template: Parameters<typeof initializeHeart>[0] | undefined,
): Promise<void> {
  if (template === undefined) return initializeHeart(paths);
  copyFileSync(template.heart, paths.heart, constants.COPYFILE_EXCL);
  copyFileSync(template.leash, paths.leash, constants.COPYFILE_EXCL);
}

function debtCatalogDocument(id: DebtId, updatedAt: string): DebtDocument {
  return {
    id,
    title: id,
    body: "",
    note: "",
    state: "open",
    priority: 2,
    needs: [],
    parent: null,
    supersedes: [],
    relates: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}





async function answered(root: string, archetype: string, suffix: string) {
  const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype, draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype,
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: root,
        allowed: ALLOWED_ACTIONS,
      },
      initialBody: "work",
    },
    provider,
    { spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
      now: () => "2026-08-11T00:00:00.000Z",
    },
  );
  return allocated;
}


test("facade ask admits, decodes, and addresses an alias through the World-bound face", { timeout: 15_000 }, async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-ask-");
  const source = await bornWorld(root, "00000009");
  await moveAlias({ world: root, alias: parseAkumaAlias("@worker"), akuId: source.allocated.id });
  const schema = Schema.json({ type: "object", properties: { ok: { type: "boolean" } } }, (value) => value as { ok: boolean });
  const bodies: Promise<unknown>[] = [];
  const spawn = fixtureLauncher(
    bodies,
    new Map([[source.allocated.paths.directory, { adapter: answering('{"ok":true}'), now: "2026-08-11T00:00:00.000Z" }]]),
  );
  try {
    // This is an answer/admission test, not a deadline test. Let the test runner
    // bound and cancel a hang without racing loaded CI against a one-second observation.
    const result = await akumasWithLauncher(root, localExecutionContext(), spawn).ask({ akuma: "@worker", body: "continue", signal: t.signal, schema });
    assert.equal(result.akuma, source.allocated.id);
    assert.equal(result.tell.row.text, "continue");
    assert.deepEqual(result.observation, { reason: "answered", answer: { ok: true } });
    if (result.observation.reason === "answered") {
      const typed: { ok: boolean } = result.observation.answer;
      assert.equal(typed.ok, true);
    }
    await assert.rejects(
      Akumas.of(root).tell({ akuma: "@worker", body: "no schema", schema } as never),
      /use Akumas.ask/u,
    );
  } finally {
    await settleFixtureBodies(bodies);
  }
});

test("facade ask refuses path selection and invalid timeout before addressing", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-ask-refusal-");
  assert.throws(
    () => Akumas.of(root).ask({ path: root, akuma: "aku/worker/00000001", body: "x", timeoutMs: 0 } as never),
    /does not accept path/u,
  );
  await assert.rejects(
    () => Akumas.of(root).ask({ akuma: "aku/worker/00000001", body: "x", timeoutMs: -1 }),
    /timeoutMs must be a nonnegative finite millisecond duration/u,
  );
  await assert.rejects(
    () => Akumas.of(root).ask({ akuma: "aku/worker/00000001", body: "x", extra: true } as never),
    /Akumas\.ask input has unknown field: extra/u,
  );
});

for (const route of ["local", "forwarded", "idle"] as const) {
  test(`${route} wait owns one scope through only its final outcome observation`, { timeout: 15_000 }, async (t) => {
    const world = await World.at(fixtureRoot(t, "keiyaku-wait-scope-"));
    const output = join(world, "wait-trace.jsonl");
    mkdirSync(join(world, "plugins"), { recursive: true });
    writeFileSync(join(world, "plugins", "wait.mjs"), `
      import { appendFileSync } from "node:fs";
      export default { manifest: { id: "wait", apiVersion: 1 }, activate() {
        const record = value => appendFileSync(${JSON.stringify(output)}, JSON.stringify(value) + "\\n");
        return {
          waitDeferral({ akumaIds }, signal) {
            record(["acquire", akumaIds]);
            return { close(cleanup) { record(["close", cleanup.aborted, signal.aborted]); } };
          },
          signals: { "akuma.outcome-observed": signal => record(["observe", signal.akumaId, signal.historyId]) }
        };
      } };
    `);
    writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {
      square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
      wait: { package: "./plugins/wait.mjs" },
    } }));
    const values = await Promise.all(["0def0001", "0def0002"].map(draw => bornBody(world, draw, WAIT_AT)));
    t.after(() => values.forEach(value => value.holder.release()));
    for (const value of values) {
      const turn = await beginTurn(value.allocated.paths, {
        bodySequence: value.body.sequence, startedAt: WAIT_AT, call: "work",
      });
      await endTurn(value.allocated.paths, {
        turnSequence: turn.sequence, completedAt: WAIT_AT,
        outcome: { kind: "answered", answer: "done", historyId: "native-result", session: { sessionId: "fixture" } },
      });
      await finishBodyIfIdle(value.allocated.paths, { sequence: value.body.sequence, at: WAIT_AT });
      value.holder.release();
    }
    const ids = values.map(value => value.allocated.id);
    let pump: BodyRequestPump | undefined;
    if (route === "forwarded") {
      const parent = await bornDirectAkuma({ root: world, archetype: "parent", draw: "0def0003", createdAt: WAIT_AT });
      t.after(() => parent.leash.release());
      const body = await parent.leash.recordBody(parent.paths, { leashTakenAt: WAIT_AT });
      const port = selectionRequestPort(world, noBodyLaunch);
      pump = await BodyRequestPump.open({
        paths: parent.paths, allowed: parent.soul.allowed, bodySequence: body.sequence,
        now: () => WAIT_AT, signal: t.signal,
        commands: selectionRequestCommands({ ...port, wait: async request => {
          const trace = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
          assert.deepEqual(trace, [["acquire", ids]], "requester acquires before forwarding; server acquires nothing");
          return await port.wait(request);
        } }),
      });
    }
    try {
      const result = route === "idle"
        ? await NativeAkuma.select(world, ids[0]!).idle({ timeoutMs: 0, signal: t.signal })
        : await (pump === undefined ? Akumas.of(world) : akumasWithExecution(world, bodyRequestExecution({ directory: pump.directory })))
          .wait({ akuma: ids, completion: "all", timeoutMs: 0, signal: t.signal });
      assert.equal(result.reason, "completed");
      const selected = route === "idle" ? ids.slice(0, 1) : ids;
      const trace: unknown[][] = readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(trace[0], ["acquire", selected]);
      assert.deepEqual(trace.slice(1, -1).sort(), selected.map(id => ["observe", id, "turn/1"]).sort());
      assert.deepEqual(trace.at(-1), ["close", false, false]);
    } finally { await pump?.close(); }
  });
}

test("facade wait refuses the retired live observer input before addressing", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-refusal-");
  await assert.rejects(
    () =>
      Akumas.of(root).wait({
        akuma: ["aku/worker/00000001"],
        observe: { observe: () => undefined },
      } as never),
    /Akumas\.wait input has unknown field: observe/u,
  );
  await assert.rejects(
    () => Akumas.of(root).wait({ akuma: ["aku/worker/00000001"], observed: () => undefined } as never),
    /Akumas\.wait input has unknown field: observed/u,
  );
});

test("facade snapshots aliases and globs with stable dedupe for wait and kill", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-selection-");
  const worker = await answered(root, "worker", "00000002");
  const reviewer = await answered(root, "reviewer", "00000001");
  await moveAlias({ world: root, alias: parseAkumaAlias("@review"), akuId: reviewer.id });

  assert.equal((await Akumas.of(root).status({ akuma: "@review" })).status.id, reviewer.id);
  const waited = await Akumas.of(root).wait({
    akuma: ["aku/*/*", "@review", worker.id],
    completion: "all",
    timeoutMs: 0,
  });
  assert.deepEqual(
    waited.observations.map((view) => view.status.id),
    [reviewer.id, worker.id],
  );

  const killed = await Akumas.of(root).kill({ akuma: ["@review", worker.id] });
  assert.deepEqual(
    killed.results.map((member) => member.id),
    [reviewer.id, worker.id],
  );
  assert.deepEqual(
    killed.results.map((member) => member.evidence),
    ["already-stopped", "already-stopped"],
  );
});

const WAIT_AT = "2026-08-11T00:00:00.000Z";

// Keep the leash held so retained history belongs to real running work.
async function retainedRunningWorker(root: string, suffix: string, at: string, historySize = 1) {
  const born = await bornDirectAkuma({ root, archetype: "worker", draw: suffix, createdAt: at });
  const body = await born.leash.recordBody(born.paths, { leashTakenAt: at });
  const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: at, call: "retained work" });
  for (let index = 0; index < historySize; index += 1) {
    await appendActivity(born.paths, { turnSequence: turn.sequence, at, event: { type: "thought", text: `retained step ${index}` } });
  }
  return {
    ...born,
    end: async () => {
      await breakBody(born.paths, { sequence: body.sequence, end: "put-down", at });
      born.leash.release();
    },
  };
}

// Count full frontier reads separately from lifecycle probes.
function waitStatementCounter() {
  const original = DatabaseSync.prototype.prepare;
  let projections = 0;
  let lifeReads = 0;
  let statements = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    const sql = String(args[0]);
    statements += 1;
    if (sql.startsWith("WITH selected(sequence) AS")) projections += 1;
    if (sql.startsWith("SELECT 1 FROM tells WHERE")) lifeReads += 1;
    return original.apply(this, args);
  };
  return {
    async measure<T>(action: () => Promise<T>) {
      projections = 0;
      lifeReads = 0;
      statements = 0;
      const value = await action();
      return { value, projections, lifeReads, statements };
    },
    restore: () => {
      DatabaseSync.prototype.prepare = original;
    },
  };
}

test("a plural wait completes from the selected set's real life", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-life-");
  const finished = await answered(root, "worker", "00000011");
  const running = await retainedRunningWorker(root, "00000012", WAIT_AT);
  try {
    const ids = [running.id, finished.id];
    const any = await executeWaitAkuma({ path: root, ids, completion: "any", timeoutMs: 5_000 });
    assert.equal(any.reason, "completed");
    assert.deepEqual(
      any.observations.map((status) => status.id),
      ids,
      "a snapshot wait keeps the caller's order",
    );
    assert.deepEqual(any.unobserved, []);
    assert.equal(defaultWaitComplete(any.observations[0]!), false);
    assert.equal(defaultWaitComplete(any.observations[1]!), true);

    const all = await executeWaitAkuma({
      path: root,
      ids,
      completion: "all",
      timeoutMs: 0,
    });
    assert.equal(all.reason, "deadline", "one running peer keeps an all wait incomplete at the deadline edge");
    assert.deepEqual(
      all.observations.map((status) => status.id),
      [running.id, finished.id],
    );
    assert.deepEqual(all.unobserved, []);

    const pending = await answered(root, "reviewer", "00000013");
    const edge = await executeWaitAkuma({
      path: root,
      ids: [finished.id, pending.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.equal(edge.reason, "completed", "full completion wins at the deadline edge");
    await recordTell(pending.paths, { kind: "tell", id: "pending-work", body: "waiting", recordedAt: WAIT_AT });
    const withPending = await executeWaitAkuma({
      path: root,
      ids: [finished.id, pending.id],
      completion: "all",
      timeoutMs: 0,
    });
    assert.equal(withPending.reason, "deadline");
    assert.equal(defaultWaitComplete(withPending.observations[0]!), true);
    assert.equal(
      defaultWaitComplete(withPending.observations[1]!),
      false,
      "a non-running peer with a pending Tell is not complete",
    );

    const nothing = await executeWaitAkuma({ path: root, ids: [], completion: "all", timeoutMs: 0 });
    assert.deepEqual(
      nothing,
      { mode: "all", reason: "deadline", observations: [], unobserved: [] },
      "an empty selection is never a vacuous completion",
    );
  } finally {
    await running.end();
  }
});

test("a plural wait polls lifecycle while skipping running projection", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-probe-");
  const first = await retainedRunningWorker(root, "00000021", WAIT_AT, 40);
  const second = await retainedRunningWorker(root, "00000022", WAIT_AT, 40);
  const ids = [first.id, second.id];
  const window = { path: root, ids, completion: "all", timeoutMs: 250 } as const;
  const counter = waitStatementCounter();
  try {
    const startedAt = performance.now();
    const silent = await counter.measure(async () => await executeWaitAkuma({ ...window }));
    const silentElapsed = performance.now() - startedAt;
    const baseline = await counter.measure(async () => await executeWaitAkuma({ ...window, predicate: defaultWaitComplete }));
    const judged = await counter.measure(async () => await executeWaitAkuma({ ...window, predicate: () => true }));
    const oneRound = ids.length;

    assert.equal(silent.value.reason, "deadline");
    assert.equal(silent.projections, oneRound, "only the final deadline round projects while both peers run");
    assert.ok(
      silent.lifeReads >= oneRound * 2,
      `the probe kept polling because neither peer was complete (${silent.lifeReads} lifecycle reads)`,
    );
    assert.ok(silentElapsed >= 200, `the polling wait still ran to its deadline (${silentElapsed}ms)`);

    assert.equal(baseline.lifeReads, baseline.projections, "the full-round baseline never uses the probe");
    assert.ok(
      silent.projections < baseline.projections,
      `the polling wait projected ${silent.projections} to the full-round baseline's ${baseline.projections}`,
    );

    assert.equal(judged.lifeReads, judged.projections, "a custom judge only reads life within full rounds");
    assert.equal(judged.value.reason, "completed");
    assert.equal(judged.projections, oneRound);

    assert.deepEqual(
      silent.value,
      baseline.value,
      "the polling wait returns exactly the full-round baseline's final statuses and budget outcome",
    );
    for (const status of silent.value.observations) {
      assert.ok(status.timeline.entries.some((entry) => entry.kind === "gap"), "retained detail exceeds the shared budget");
      assert.ok(status.timeline.entries.some((entry) => entry.kind === "row" && entry.row.kind === "call"), "each opening input remains pinned");
    }
    t.diagnostic(`250ms two-worker wait: polling ${silent.projections} projections / ${silent.statements} SQL statements / ${silent.lifeReads} member rounds; baseline ${baseline.projections} projections / ${baseline.statements} SQL statements / ${baseline.lifeReads} member rounds; elapsed ${Math.round(silentElapsed)}ms`);
    // Independent wall-clock windows can finish different round counts under load.
    // Compare SQL per member round; cadence and projection savings are checked above.
    assert.ok(
      silent.statements / silent.lifeReads < baseline.statements / baseline.lifeReads,
      "polling rounds reduce SQL work per member round against the full-round baseline",
    );
    assert.deepEqual(silent.value.unobserved, []);
  } finally {
    counter.restore();
    await first.end();
    await second.end();
  }
});

test("a transiently unreadable plural peer proves nothing until the next round", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-transient-");
  const first = await answered(root, "worker", "00000031");
  const second = await answered(root, "worker", "00000032");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let lifecycleReads = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = originalPrepare.apply(this, args);
    if (String(args[0]).startsWith("SELECT 1 FROM tells WHERE")) {
      lifecycleReads += 1;
      if (lifecycleReads === 2)
        statement.get = () => {
          throw new Error("transient Heart read failure");
        };
    }
    return statement;
  };
  try {
    const startedAt = performance.now();
    const result = await executeWaitAkuma({
      path: root,
      ids: [first.id, second.id],
      completion: "all",
      timeoutMs: 5_000,
    });
    const elapsed = performance.now() - startedAt;
    assert.equal(result.reason, "completed");
    assert.ok(
      lifecycleReads >= 4,
      `the unreadable member was retried on the next round (${lifecycleReads} lifecycle reads)`,
    );
    assert.ok(elapsed >= 90, `the unreadable member proved nothing, so one ordinary round was skipped (${elapsed}ms)`);
    assert.deepEqual(
      result.observations.map((status) => status.id),
      [first.id, second.id],
      "the full round still returns every selected member in caller order",
    );
    assert.deepEqual(result.unobserved, []);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
});

test("a persistently unreadable plural peer is reported unobserved at the deadline", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-unreadable-");
  const readable = await answered(root, "worker", "00000041");
  const broken = await answered(root, "worker", "00000042");
  writeFileSync(broken.paths.heart, "not a Heart database\n");
  const result = await executeWaitAkuma({
    path: root,
    ids: [readable.id, broken.id],
    completion: "all",
    timeoutMs: 150,
  });
  assert.equal(result.reason, "deadline", "an unreadable member never proves completion");
  assert.deepEqual(
    result.observations.map((status) => status.id),
    [readable.id],
  );
  assert.deepEqual(
    result.unobserved.map((member) => member.id),
    [broken.id],
  );
  assert.ok((result.unobserved[0]!.diagnostic ?? "").length > 0, "the final round reports the real diagnostic");
  assert.equal(defaultWaitComplete(result.observations[0]!), true, "a readable peer keeps its own honest evidence");

  const any = await executeWaitAkuma({
    path: root,
    ids: [broken.id, readable.id],
    completion: "any",
    timeoutMs: 5_000,
  });
  assert.equal(any.reason, "completed", "an unreadable first member does not hide a completed peer");
  assert.deepEqual(any.observations.map((status) => status.id), [readable.id]);
  assert.deepEqual(any.unobserved.map((member) => member.id), [broken.id]);
  await assert.rejects(
    executeWaitAkuma({ path: root, ids: [broken.id], completion: "all", timeoutMs: 0 }),
    /not a database/u,
    "a single identity still propagates its read failure",
  );
});

test("cancellation reaches a plural probe between selected identities", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-cancel-");
  const first = await retainedRunningWorker(root, "00000051", WAIT_AT);
  const second = await retainedRunningWorker(root, "00000052", WAIT_AT);
  const before = (await activitySlice(first.paths)).highest;
  const controller = new AbortController();
  const reason = new Error("caller cancelled the plural wait");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let lifecycleReads = 0;
  let projections = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    const sql = String(args[0]);
    if (sql.startsWith("WITH selected(sequence) AS")) projections += 1;
    if (sql.startsWith("SELECT 1 FROM tells WHERE")) {
      lifecycleReads += 1;
      if (lifecycleReads === 1) controller.abort(reason);
    }
    return originalPrepare.apply(this, args);
  };
  try {
    await assert.rejects(
      executeWaitAkuma({
        path: root,
        ids: [first.id, second.id],
        completion: "all",
        timeoutMs: 5_000,
        signal: controller.signal,
      }),
      (error: unknown) => error === reason,
    );
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await first.end();
    await second.end();
  }
  assert.equal(lifecycleReads, 1, "the abort stopped the probe between selected identities");
  assert.equal(projections, 0, "cancellation stops observation before a full round");
  assert.equal((await activitySlice(first.paths)).highest, before, "cancellation interrupted observation, not work");
});

test("a Tell admitted after a completion probe is judged by the full round", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-successor-");
  const first = await answered(root, "worker", "00000061");
  const second = await retainedRunningWorker(root, "00000062", WAIT_AT);
  const originalTry = HeldAkumaLeash.try;
  let firstReads = 0;
  t.mock.method(HeldAkumaLeash, "try", async (paths: typeof first.paths) => {
    const claim = await originalTry(paths);
    if (paths.directory === first.paths.directory && ++firstReads === 2) {
      await recordTell(first.paths, { kind: "tell", id: "new-work", body: "continue", recordedAt: WAIT_AT });
    }
    return claim;
  });
  try {
    const result = await executeWaitAkuma({
      path: root,
      ids: [first.id, second.id],
      completion: "any",
      timeoutMs: 150,
    });
    assert.equal(result.reason, "deadline", "a stale probe cannot return completion");
    assert.ok(firstReads > 2, "the shared loop continues after full evidence invalidates the probe");
    assert.ok(result.observations.every((status) => !defaultWaitComplete(status)));
    assert.ok(result.observations[0]!.timeline.entries.some((entry) => entry.kind === "row" && entry.row.kind === "tell" && entry.row.state === "pending"));
  } finally {
    t.mock.restoreAll();
    await second.end();
  }
});

test("a missing Soul remains a hard failure behind a running plural peer", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-wait-not-born-");
  const running = await retainedRunningWorker(root, "00000071", WAIT_AT);
  const missing = akuId({ archetype: "worker", suffix: "00000072" });
  try {
    for (const completion of ["any", "all"] as const) {
      await assert.rejects(
        executeWaitAkuma({ path: root, ids: [running.id, missing], completion, timeoutMs: 5_000 }),
        { name: "AkumaNotBornError" },
      );
    }
  } finally {
    await running.end();
  }
});
test("wait reselects an unchanged later Heart when an earlier member releases the shared budget", async (t) => {
  const root = fixtureRoot(t, "keiyaku-live-wait-budget-");
  const members: (Awaited<ReturnType<typeof bornDirectAkuma>> & { turn: Awaited<ReturnType<typeof beginTurn>> })[] = [];
  const at = "2026-10-01T00:00:00.000Z";
  for (let index = 0; index < 6; index += 1) {
    const born = await bornDirectAkuma({
      root,
      archetype: "worker",
      draw: index.toString(16).padStart(8, "0"),
      createdAt: at,
    });
    t.after(() => born.leash.release());
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: at });
    const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: at, call: "opening" });
    for (let row = 0; row < 6; row += 1)
      await appendActivity(born.paths, {
        turnSequence: turn.sequence,
        event: { type: "thought", text: `detail-${row}` },
        at,
      });
    members.push({ ...born, turn });
  }
  const later = members[5]!;
  const reader = createLiveStatusReader(later.paths, later.id);
  const input = { aperture: "monitoring" as const };
  const zero = await reader.read({ ...input, ordinaryBudget: 0 });
  const six = await reader.read({ ...input, ordinaryBudget: 6 });
  assert.strictEqual(six.rows, zero.rows, "budget changes reuse the ledger");
  assert.notStrictEqual(six.status.timeline, zero.status.timeline, "budget changes rerun selection");
  assert.strictEqual(
    (await reader.read({ ...input, ordinaryBudget: 30 })).status.timeline,
    six.status.timeline,
    "normalized equivalent budgets reuse selection",
  );
  reader.clear();
  const controller = new AbortController();
  const reason = new Error("budget change witnessed");
  let judgements = 0;
  let closing: Promise<unknown> | undefined;
  const selectedCounts: number[] = [];
  // A custom judge forces full rounds without a live viewer; each round judges every observed member.
  await assert.rejects(
    executeWaitAkuma({
      path: root,
      ids: members.map((member) => member.id),
      completion: "all",
      signal: controller.signal,
      predicate(status) {
        if (status.id === later.id) {
          selectedCounts.push(
            status.timeline.entries.filter((entry) => entry.kind === "row" && entry.row.kind === "thought").length,
          );
        }
        judgements += 1;
        if (judgements === members.length)
          closing = endTurn(members[0]!.paths, {
            turnSequence: members[0]!.turn.sequence,
            outcome: { kind: "failed", diagnostic: "done" },
            completedAt: at,
          });
        if (judgements === members.length * 3) controller.abort(reason);
        return false;
      },
    }),
    (error) => error === reason,
  );
  await closing;
  assert.deepEqual(selectedCounts, [0, 6, 6]);
});

test("one and ten selected identities use one Dispatch batch at final wait attachment", async (t) => {
  const repository = fixtureRepository(t);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const world = await World.at(repository.path);
  const ids: AkuId[] = [];
  for (let index = 0; index < 10; index += 1) {
    ids.push((await answered(world, "worker", index.toString(16).padStart(8, "0"))).id);
  }
  await publishDispatch({
    repository: await repositoryAt(world),
    akuId: akuId({ archetype: "worker", suffix: "ffffffff" }),
    contractId: contractId("kei/unrelated"),
  });
  const log = join(repository.path, "wait-git-spawns.log");
  await withGitShim(
    'printf "%s\\n" "$1" >> "$KEIYAKU_WAIT_SPAWNS"\nexec "$KEIYAKU_REAL_GIT" "$@"',
    { KEIYAKU_WAIT_SPAWNS: log },
    async (gitPath) => {
      const repo = await Repo.at({ path: world, gitPath });
      for (const selected of [ids.slice(0, 1), ids]) {
        writeFileSync(log, "");
        const result = await Akumas.of(world).wait({
          akuma: [...selected, selected[0]!],
          repo,
          completion: "all",
          timeoutMs: 0,
        });
        assert.deepEqual(
          result.observations.map((observation) => observation.status.id),
          selected,
        );
        assert.ok(result.observations.every((observation) => observation.contract.kind === "none"));
        assert.equal(readFileSync(log, "utf8"), "rev-parse\ncat-file\n");
        t.diagnostic(`${selected.length} IDs: one final attachment batch, 2 Git spawns`);
      }
    },
  );
});

test(
  "wait observes a Dispatch published during polling at final attachment",
  { timeout: 15_000 },
  async (t) => {
    const repository = fixtureRepository(t);
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
    const { world, allocated } = await bornWorld(repository.path, "dddddd01");
    const peer = await answered(world, "worker", "dddddd02");
    const owner = contractId("kei/published-during-wait");
    const git = await repositoryAt(world);
    // Seed private authority so selection opens a decode channel even though both selected associations are absent.
    await publishDispatch({
      repository: git,
      akuId: akuId({ archetype: "worker", suffix: "dddddd03" }),
      contractId: owner,
    });
    const started = promiseBarrier<void>();
    const finish = promiseBarrier<void>();
    const adapter = fixtureAdapter(async () => {
      started.resolve();
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "waiting" } };
          },
        },
        completion: finish.promise.then(() => ({
          kind: "answered" as const,
          answer: "done",
          historyId: "waiting-history",
        })),
        resource: {
          abort: async () => {
            finish.resolve();
          },
        },
      };
    });
    const bodies: Promise<unknown>[] = [];
    const spawn = fixtureLauncher(bodies, new Map([[allocated.paths.directory, { adapter, now: "2026-08-11T00:00:00.000Z" }]]));
    const log = join(repository.path, "dispatch-channels.log");
    writeFileSync(log, "");
    try {
      await akumasWithLauncher(world, localExecutionContext(), spawn).tell({ akuma: allocated.id, body: "wait for Dispatch" });
      await started.promise;
      await withGitShim(
        [
          'if [ "$1 $2" = "cat-file --batch" ]; then',
          '  printf "opened\\n" >> "$KEIYAKU_CHANNEL_LOG"',
          '  "$KEIYAKU_REAL_GIT" "$@"',
          '  printf "closed\\n" >> "$KEIYAKU_CHANNEL_LOG"',
          "  exit 0",
          "fi",
          'exec "$KEIYAKU_REAL_GIT" "$@"',
        ].join("\n"),
        { KEIYAKU_CHANNEL_LOG: log },
        async (gitPath) => {
          const originalTry = HeldAkumaLeash.try;
          let waiting = false;
          let hooked = false;
          let logWhilePolling: string | undefined;
          let publication: ReturnType<typeof publishDispatch> | undefined;
          // The first lifecycle probe after the wait starts is the deterministic seam: polling has
          // begun, no Dispatch channel is open yet, and a later publication must still be attached.
          t.mock.method(HeldAkumaLeash, "try", async (paths: Parameters<typeof originalTry>[0]) => {
            if (waiting && !hooked && paths.heart === allocated.paths.heart) {
              hooked = true;
              logWhilePolling = readFileSync(log, "utf8");
              publication = publishDispatch({ repository: git, akuId: allocated.id, contractId: owner });
              void publication.finally(() => finish.resolve());
            }
            return await originalTry(paths);
          });
          try {
            waiting = true;
            const result = await Akumas.of(world).wait({
              akuma: [allocated.id, peer.id, allocated.id],
              repo: await Repo.at({ path: world, gitPath }),
              completion: "all",
              signal: t.signal,
            });
            assert.equal(logWhilePolling, "", "the polling wait opens no Dispatch channel");
            assert.equal((await publication)?.kind, "dispatched");
            assert.equal(result.reason, "completed");
            assert.deepEqual(
              result.observations.map((observation) => [observation.status.id, observation.contract]),
              [
                [allocated.id, { kind: "associated", contractId: owner }],
                [peer.id, { kind: "none" }],
              ],
            );
            const channels = readFileSync(log, "utf8").trim().split("\n");
            assert.ok(channels.length >= 2, "final attachment opens a fresh channel");
            assert.deepEqual(channels, Array.from({ length: channels.length / 2 }, () => ["opened", "closed"]).flat());
          } finally {
            t.mock.restoreAll();
          }
        },
      );
    } finally {
      finish.resolve();
        await settleFixtureBodies(bodies);
    }
  },
);

test("facade ls reads exactly one selected identity directory", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-catalog-");
  const home = mkdtempSync(join(tmpdir(), "keiyaku-facade-catalog-home-"));
  try {
    const source = await answered(root, "worker", "00000001");
    const debt = await Debts.of(await World.at(root)).add({ title: "Catalog debt" });
    assert.equal(debt.kind, "accepted");
    mkdirSync(join(home, "akumas"));
    writeFileSync(
      join(home, "akumas", "reviewer.md"),
      [
        "---",
        "provider: missing",
        "model: review-model",
        "description: Complete catalog description.",
        "---",
        "prompt",
        "",
      ].join("\n"),
    );
    const debts = await Debts.of(await World.at(root)).list({ selection: "all" });
    assert.equal(debts.kind, "accepted");
    assert.deepEqual(debts.value.rows, [
      {
        id: debt.value.id,
        title: "Catalog debt",
        state: "open",
        priority: 2,
        disposition: "ready",
        updatedAt: debt.value.updatedAt,
        bodyPresent: false,
      },
    ]);
    assert.deepEqual(await listArchetypeDefinitions({ home }), {
      rows: [{ name: "reviewer", model: "review-model", description: "Complete catalog description." }],
      hasMore: false,
    });
    const workers = await Akumas.of(await World.at(root)).list({ archetype: "worker" });
    assert.deepEqual(
      workers.rows.map((row) => row.id),
      [source.id],
    );
    assert.deepEqual((await Akumas.of(await World.at(root)).list({ archetype: "reviewer" })).rows, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Akumas roster returns bounded Heart activity in semantic order", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-page-");
  const first = await answered(root, "worker", "00000003");
  const tiedFirst = await answered(root, "worker", "00000001");
  const tiedSecond = await answered(root, "worker", "00000002");
  const reviewer = await answered(root, "reviewer", "00000001");
  await appendActivity(first.paths, {
    turnSequence: 1,
    event: { type: "unknown", kind: "fixture" },
    at: "2026-08-11T00:00:01.000Z",
  });
  for (const source of [tiedFirst, tiedSecond]) {
    await appendActivity(source.paths, {
      turnSequence: 1,
      event: { type: "unknown", kind: "fixture" },
      at: "2026-08-11T00:00:02.000Z",
    });
  }
  await appendActivity(reviewer.paths, {
    turnSequence: 1,
    event: { type: "unknown", kind: "fixture" },
    at: "2026-08-11T00:00:03.000Z",
  });

  const page = await Akumas.of(await World.at(root)).list({ archetype: "worker", limit: 2 });
  assert.deepEqual(
    page.rows.map((row) => row.id),
    [tiedFirst.id, tiedSecond.id],
  );
  assert.equal(page.hasMore, true);
  const originalPrepare = DatabaseSync.prototype.prepare;
  let custodyReads = 0;
  DatabaseSync.prototype.prepare = function (...args) {
    custodyReads += 1;
    return originalPrepare.apply(this, args);
  };
  try {
    await assert.rejects(
      Akumas.of(await World.at(root)).list({ limit: 501 }),
      /limit must be an integer from 1 to 500/u,
    );
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
  }
  assert.equal(custodyReads, 0);
});

test("Akumas roster refuses a corrupt alias authority rather than hiding bindings", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-alias-corrupt-");
  await answered(root, "worker", "00000003");
  mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "akuma", "alias.json"), "not json\n");
  await assert.rejects(Akumas.of(await World.at(root)).list(), /invalid Alias JSON/u);
});

test("recent Akuma page prunes physical reads and preserves complete membership", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-page-scale-");
  const old = new Date("2000-01-01T00:00:00.000Z");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let template: Parameters<typeof initializeHeart>[0] | undefined;
  // Pagination limits are asserted at the owner below; physical pruning needs a small mixed catalogue.
  const oldCount = PAGE_POOL_SIZE;
  try {
    const oldIds = [];
    for (let index = 0; index < oldCount; index += 1) {
      const suffix = index.toString(16).padStart(8, "0");
      const allocated = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => suffix });
      await initializeUnbornFixture(allocated.paths, template);
      template ??= allocated.paths;
      oldIds.push(allocated.id);
      utimesSync(allocated.paths.heart, old, old);
      try {
        utimesSync(`${allocated.paths.heart}-wal`, old, old);
      } catch {}
    }
    const recent = await Promise.all(
      Array.from({ length: 3 }, async (_, index) => {
        const source = await answered(root, "worker", `a00000${index.toString(16).padStart(2, "0")}`);
        await appendActivity(source.paths, {
          turnSequence: 1,
          event: { type: "unknown", kind: "fixture" },
          at: `2099-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        });
        return source;
      }),
    );
    let prepareCalls = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      prepareCalls += 1;
      return originalPrepare.apply(this, args);
    };
    const world = Akuma.of(await World.at(root));
    const page = await world.list({ limit: 2 });
    const pagePrepares = prepareCalls;
    DatabaseSync.prototype.prepare = originalPrepare;
    prepareCalls = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      prepareCalls += 1;
      return originalPrepare.apply(this, args);
    };
    const complete = await world.listComplete();
    const completePrepares = prepareCalls;
    DatabaseSync.prototype.prepare = originalPrepare;
    const reference = complete.rows.map((row) => row.id);
    const completeGlob = await addressAkumaSet({ path: root, akuma: ["aku/*/*"] });

    assert.equal(typeof world.listComplete, "function");
    assert.equal("hasMore" in complete, false);
    assert.deepEqual(
      reference,
      [...recent]
        .reverse()
        .map((source) => source.id)
        .concat(oldIds),
    );
    assert.deepEqual(completeGlob.ids, [...oldIds, ...recent.map((source) => source.id)].sort());
    assert.deepEqual(
      page.rows.map((row) => row.id),
      reference.slice(0, 2),
    );
    assert.equal(page.hasMore, true);
    assert.deepEqual(
      page.rows.map((row) => row.id),
      recent
        .slice()
        .reverse()
        .slice(0, 2)
        .map((row) => row.id),
    );
    assert.ok(pagePrepares < completePrepares, `pruned page ${pagePrepares} must read less than complete ${completePrepares}`);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true });
  }
});

test("all-null Akuma fallback retains exact membership through the fixed Heart read pool", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-akuma-page-null-");
  const originalPrepare = DatabaseSync.prototype.prepare;
  let template: Parameters<typeof initializeHeart>[0] | undefined;
  try {
    const allocated = [];
    for (let index = 0; index < PAGE_POOL_SIZE * 2 + 1; index += 1) {
      const suffix = index.toString(16).padStart(8, "0");
      const value = await allocateAkumaDirectory({ worldRoot: root, archetype: "worker", draw: () => suffix });
      await initializeUnbornFixture(value.paths, template);
      template ??= value.paths;
      allocated.push(value);
    }

    let custodyReads = 0;
    DatabaseSync.prototype.prepare = function (...args) {
      custodyReads += 1;
      return originalPrepare.apply(this, args);
    };
    const world = Akuma.of(await World.at(root));
    const page = await world.list({ limit: 7 });
    DatabaseSync.prototype.prepare = originalPrepare;

    const expected = allocated.map((value) => value.id).sort();
    assert.deepEqual(
      page.rows.map((row) => row.id),
      expected.slice(0, 7),
    );
    assert.equal(page.hasMore, true);
    assert.ok(
      custodyReads >= expected.length,
      `expected every null activity Heart to be read, received ${custodyReads}`,
    );

    let active = 0;
    let maximum = 0;
    await boundedMap(Array.from({ length: PAGE_POOL_SIZE * 3 }), async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
    });
    assert.equal(maximum, PAGE_POOL_SIZE);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(root, { recursive: true, force: true });
  }
});

test("recent Debt catalog does not skip older-mtime malformed authority", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-debt-catalog-malformed-");
  mkdirSync(join(root, ".keiyaku", "debts"), { recursive: true });
  const world = await World.at(root);
  const older = debtAuthorityFile(world, "debt/older-malformed");
  const newer = debtCatalogDocument("debt/newer-valid", "2026-08-31T00:00:00.000Z");
  writeFileSync(older, "not a debt document\n");
  utimesSync(older, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  writeFileSync(debtAuthorityFile(world, newer.id), serializeDebtDocument(newer));
  utimesSync(
    debtAuthorityFile(world, newer.id),
    new Date("2099-01-01T00:00:00.000Z"),
    new Date("2099-01-01T00:00:00.000Z"),
  );

  await assert.rejects(Debts.of(world).list({ selection: "all", limit: 1 }), /front matter/u);
});

test("named Address resolution refuses a Contract short-id shared with an Alias", async (t) => {
  const repository = fixtureRepository(t);
  const repo = await Repo.at({ path: repository.path });

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const bound = accepted(await Keiyaku.with().bind({
    repo,
    markdown: [
      "# Review",
      "",
      "## Context",
      "ambiguity",
      "",
      "## Objective",
      "refuse",
      "",
      "## Design",
      "one selector judge",
      "",
      "## Region",
      "```",
      "src/**",
      "```",
      "",
      "## Criteria",
      "### Visible",
      "Ambiguity is explicit.",
      "",
    ].join("\n"),
  }));
  const boundId = (present(await bound.value.keiyaku.state())).id;
  assert.match(boundId, /^kei\/review-[0-9a-f]{4}$/u);
  const alias = parseAkumaAlias(`@${contractSegment(boundId)}`);
  const source = await answered(repository.path, "worker", "00000001");
  const path = await World.at(repository.path);
  await moveAlias({ world: path, alias, akuId: source.id });
  const authority = await observeNamedAddress({ world: path, repo });
  assert.throws(
    () =>
      resolveNamedAddress({ selector: alias, contracts: authority.contracts, aliases: authority.aliases }),
    /ambiguous selector matches Contract and Akuma/u,
  );
});

test("named Address refuses failed Kanshi Contract and Alias observations", async (t) => {
  const root = fixtureRoot(t, "keiyaku-named-kanshi-failed-");
  const failure = { kind: "failed" as const, failure: { message: "unavailable" } };
  const source = await answered(root, "worker", "00000002");
  const alias = parseAkumaAlias("@readable");
  await moveAlias({ world: root, alias, akuId: source.id });
  const detached = await observeNamedAddress({ world: root, repo: null });
  assert.deepEqual(
    resolveNamedAddress({
      selector: alias,
      contracts: failure,
      aliases: { kind: "present", value: await readAliases(root) },
    }),
    { kind: "akuma", id: source.id },
    "a readable Alias remains an Akuma address when optional Contract composition is degraded",
  );
  assert.throws(
    () => resolveNamedAddress({ selector: "@missing", contracts: failure, aliases: detached.aliases }),
    /Contract world is failed/u,
  );
  assert.throws(
    () => resolveNamedAddress({ selector: "@missing", contracts: detached.contracts, aliases: failure }),
    /Alias authority is failed/u,
  );
  assert.throws(
    () => resolveNamedAddress({ selector: "@missing", contracts: detached.contracts, aliases: detached.aliases }),
    /unknown Akuma alias: @missing/u,
    "an absent Repo is a World without a Contract family, so an unknown name stays an unknown Alias",
  );
});

test("named Address resolves a retained Alias outside Kanshi roster rows", async (t) => {
  const root = fixtureRoot(t, "keiyaku-named-kanshi-alias-");
  const id = akuId({ archetype: "worker", suffix: "deadbeef" });
  await moveAlias({ world: root, alias: parseAkumaAlias("@outside"), akuId: id });
  const observation = await observeKanshi({ world: root });
  const authority = await observeNamedAddress({ world: root, repo: null });
  assert.equal(observation.report.akuma.kind, "present");
  assert.equal(
    observation.report.akuma.kind === "present" && observation.report.akuma.value.rows.some((row) => row.id === id),
    false,
  );
  assert.deepEqual(
    resolveNamedAddress({ selector: "@outside", contracts: authority.contracts, aliases: authority.aliases }),
    {
      kind: "akuma",
      id,
    },
  );
});

test("cross-World Contract selector wait and kill refuse before operating", async (t) => {
  const rawA = fixtureRepository(t);
  const rawB = fixtureRepository(t);
  for (const repository of [rawA, rawB]) {
    repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  }
  const worldA = await World.at(rawA.path);
  const worldB = await World.at(rawB.path);
  const born = await answered(worldA, "worker", "deadbeef");
  const owner = contractId("kei/foreign");
  assert.equal(
    (
      await publishDispatch({
        repository: await repositoryAt(worldB),
        akuId: born.id,
        contractId: owner,
      })
    ).kind,
    "dispatched",
  );
  const repoB = await Repo.at({ path: worldB });
  const wait = Akumas.of(worldB).wait({
    akuma: ["kei/foreign"],
    repo: repoB,
    timeoutMs: 0,
  });
  await assert.rejects(wait, (error: unknown) => {
    assert.ok(error instanceof AkumaWorldScopeError);
    assert.deepEqual(error.refusal, { kind: "akuma-not-in-world", ids: [born.id], world: worldB });
    assert.doesNotMatch(error.message, /is not born/u);
    return true;
  });
  await assert.rejects(
    Akumas.of(worldB).kill({
    akuma: ["kei/foreign"], repo: repoB }),
    (error: unknown) => error instanceof AkumaWorldScopeError && error.refusal.kind === "akuma-not-in-world",
  );
});

test("selection status projects Dispatch association without changing Akuma core", async (t) => {
  const repository = fixtureRepository(t);

  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const source = await answered(repository.path, "worker", "deadbeef");
  const owner = contractId("kei/provider-core");
  assert.equal(
    (await publishDispatch({ repository: await repositoryAt(repository.path), akuId: source.id, contractId: owner }))
      .kind,
    "dispatched",
  );

  const world = await World.at(repository.path);
  const plain = await Akumas.of(world).status({
    akuma: source.id });
  assert.equal("contractId" in plain, false);
  assert.equal(plain.status.id, source.id);
  const projected = await Akumas.of(world).status({
    akuma: source.id,
    repo: await Repo.at({ path: repository.path }),
  });
  assert.deepEqual(projected.contract, { kind: "associated", contractId: owner });
  assert.equal(projected.status.id, source.id);
  const waited = await Akumas.of(world).wait({
    akuma: [source.id],
    repo: await Repo.at({ path: repository.path }),
    timeoutMs: 0,
  });
  assert.deepEqual(waited.observations[0]!.contract, { kind: "associated", contractId: owner });
});

test("multi-member wait and kill project every member from one Debt board snapshot", async (t) => {
  const root = fixtureRoot(t, "keiyaku-facade-created-set-");
  const worker = await answered(root, "worker", "00000001");
  const reviewer = await answered(root, "reviewer", "00000002");
  const world = await World.at(root);
  writeCreatorDebt(
    world,
    creatorDebt({
      id: "debt/from-worker",
      title: "From worker",
      createdBy: worker.id,
      priority: 1,
    }),
  );
  writeCreatorDebt(
    world,
    creatorDebt({
      id: "debt/from-reviewer",
      title: "From reviewer",
      createdBy: reviewer.id,
      priority: 0,
      state: "drop",
    }),
  );
  const expected = projectDebtBoardObservation((await readBoard(world)).board);
  const status = await Akumas.of(root).status({ akuma: worker.id });
  assert.deepEqual(status.createdDebts, { kind: "present", rows: expected.selectCreatedBy(worker.id) });
  const waited = await Akumas.of(root).wait({
    akuma: [worker.id, reviewer.id],
    completion: "all",
    timeoutMs: 0,
  });
  assert.deepEqual(
    waited.observations.map((observation) => observation.status.id),
    [worker.id, reviewer.id],
  );
  assert.deepEqual(
    waited.observations.map((observation) => observation.createdDebts),
    [
      { kind: "present", rows: expected.selectCreatedBy(worker.id) },
      { kind: "present", rows: expected.selectCreatedBy(reviewer.id) },
    ],
  );
  const killed = await Akumas.of(root).kill({
    akuma: [worker.id, reviewer.id] });
  assert.deepEqual(
    killed.results.map((member) => member.id),
    [worker.id, reviewer.id],
  );
  assert.equal(
    killed.results.every((member) => !("observation" in member)),
    true,
  );
});

function fixtureRepository(t: TestContext) {
  const repository = makeGitRepository();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  return repository;
}

test("failed Debt associations do not hide readable roster members or kill evidence", async (t) => {
  const root = fixtureRoot(t, "keiyaku-roster-debt-failure-");
  const a = await answered(root, "worker", "a0000001");
  const b = await answered(root, "worker", "a0000002");
  mkdirSync(join(root, ".keiyaku", "debts"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "debts", "bad.md"), "not Debt authority\n");
  const status = await Akumas.of(root).status({
    akuma: a.id });
  assert.equal(status.status.id, a.id);
  assert.equal(status.createdDebts.kind, "failed");
  const waited = await Akumas.of(root).wait({
    akuma: [a.id, b.id], completion: "all", timeoutMs: 0 });
  assert.deepEqual(waited.observations.map((view) => view.status.id).sort(), [a.id, b.id]);
  assert.deepEqual(
    waited.observations.map((view) => view.createdDebts),
    [status.createdDebts, status.createdDebts],
  );
  const killed = await Akumas.of(root).kill({
    akuma: [a.id, b.id] });
  assert.deepEqual(killed.results.map((member) => member.id).sort(), [a.id, b.id]);
  assert.ok(killed.results.every((member) => member.evidence === "already-stopped" && !("observation" in member)));
});

// Keep the exact maximum boundary at the pagination owner, independent of filesystem scale.
test("bounded list defaults, maximum and one-past-maximum are explicit", () => {
  assert.equal(boundedListLimit(), 50);
  assert.equal(boundedListLimit(500), 500);
  for (const invalid of [0, -1, 1.5, 501, NaN, Infinity, "50", null]) {
    assert.throws(() => boundedListLimit(invalid), /limit must be an integer from 1 to 500/u);
  }
  for (const [count, limit, expected, more] of [[0, 50, 0, false], [50, 50, 50, false], [51, 50, 50, true], [499, 500, 499, false], [500, 500, 500, false], [501, 500, 500, true]] as const) {
    const rows = Array.from({ length: count }, (_, index) => `row-${index}`);
    const before = rows.slice();
    const page = projectBoundedList(rows, limit);
    assert.deepEqual(page, { rows: before.slice(0, expected), hasMore: more });
    assert.deepEqual(rows, before, "projection must not mutate its input");
  }
});
