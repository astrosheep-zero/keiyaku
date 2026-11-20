import { temporaryDirectory } from "./support/process.js";
import { settlementProbe, waitForCondition } from "./support/process.js";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { AkumaNameError, loadPreparedArchetype } from "../src/akuma/archetype.js";
import {
  beginTurn,
  bindTellsToTurn,
  endTurn,
  finishBodyIfIdle,
  HeldAkumaLeash,
  readHeart,
  readLatestTurnForBody,
  readSoul,
  readTell,
  readTurn,
  recordTell,
} from "../src/akuma/heart/index.js";
import { parseAkumaId, pathsForAkumaId } from "../src/akuma/identity.js";
import { Akuma as PublicAkuma } from "../src/akuma/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { Akumas, Repo, World, Settings } from "../src/index.js";
import {
  cleanupSpawnCapableFixtureForTest,
  installAkumaBodyEmptyPublicationBarrier,
  installAkumaBodyIdleFinishBarrier,
  installAkumaBodyPidReceipt,
} from "./support/process.js";
import { AkumaOwner, isolateSquareFixtureLedger } from "./support/akuma-composition.js";
import { settledInput } from "./support/akuma-tell.js";
import { makeGitRepository } from "./support/git.js";
import { isolateUserHome } from "./support/user-home.js";

// Body plugin Settings use the process home, independently of the explicit
// Archetype home below. Keep ambient observers out of these owned fixtures:
// their bounded birth/end callbacks can legitimately outlive the departure budget.
isolateUserHome();

// Bind one direct-call fixture's PID receipt; the scenario keeps cleanup and restore order.
function bodyReceiptFixture(t: TestContext, fixturePath: string) {
  const pidReceiptPath = join(fixturePath, "body-pids");
  const restore = installAkumaBodyPidReceipt(pidReceiptPath);
  return {
    restore,
    async cleanup(
      operationFailed: boolean,
      options: Readonly<{ timeoutMs?: number; expectRetainedEvidence?: boolean }> = {},
    ) {
      await cleanupSpawnCapableFixtureForTest(t, {
        fixturePath,
        pidReceiptPath,
        operationFailed,
        ...options,
      });
    },
  };
}

async function repositoryFixture() {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return { raw, repo: await Repo.at({ path: raw.path }), git: await repositoryAt(raw.path) };
}

async function directArchetypeSettings(root: string, answerReleasePath?: string) {
  const home = join(root, ".direct-settings");
  const executable = join(root, "fake-codex");
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(home, "akumas"), { recursive: true });
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: local\n---\nWork.\n");
  const config = {
    service_tier: "priority",
    sandbox_mode: "workspace-write",
    sandbox_workspace_write: { writable_roots: [root], network_access: false },
  };
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      providers: { local: { kind: "codex-app-server", executable, config } },
    }),
  );
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "const { existsSync } = require('node:fs');",
      `const answerReleasePath = ${JSON.stringify(answerReleasePath ?? null)};`,
      "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
      "const reply = (message, result) => send({ id: message.id, result });",
      "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "let turnId = 'turn-1';",
      "lines.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') return reply(message, {});",
      "  if (message.method === 'initialized') return;",
      "  if (message.method === 'config/read') return reply(message, { config: {} });",
      "  if (message.method === 'thread/resume') turnId = 'turn-resumed';",
      "  if (message.method === 'thread/start' || message.method === 'thread/resume') return reply(message, { thread: { id: 'thread-1' } });",
      "  if (message.method === 'thread/fork') return reply(message, { thread: { id: 'thread-child' } });",
      "  if (message.method !== 'turn/start') return;",
      "  reply(message, { turn: { id: turnId } });",
      "  const answer = () => {",
      "    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{\"ok\":true}' } } });",
      "    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });",
      "  };",
      "  if (answerReleasePath === null || existsSync(answerReleasePath)) return answer();",
      "  const timer = setInterval(() => {",
      "    if (!existsSync(answerReleasePath)) return;",
      "    clearInterval(timer);",
      "    answer();",
      "  }, 5);",
      "});",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const value = await Settings.load({ cwd: root, home });
  return { home, value, config, placement: { home, settings: value } };
}

async function directCallFixture(options: Readonly<{ holdAnswer?: boolean }> = {}) {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const answerReleasePath = options.holdAnswer === true ? join(raw.path, "answer-release") : undefined;
  return {
    raw,
    world,
    configured: await directArchetypeSettings(world, answerReleasePath),
    releaseAnswer() {
      if (answerReleasePath !== undefined) writeFileSync(answerReleasePath, "release\n");
    },
  };
}

test("malformed explicit callers refuse before allocation on public call and fork", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-caller-refusal-"));
  const caller = { kind: "unknown" } as never;
  await assert.rejects(Akumas.of(world).spawn({ akumaName: "worker", caller }), /Invalid Akuma caller/u);
  await assert.rejects(
    Akumas.of(world).fork({ akuma: "aku/worker/1234abcd", at: "turn/1", caller }),
    /Invalid Akuma caller/u,
  );
  assert.equal((await Akumas.of(world).list()).rows, undefined);
});

test("prompt-free spawn settles before immediate Ask and retains native config through wake and fork", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const departure = bodyReceiptFixture(t, raw.path);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let operationFailed = true;
  try {
    const api = Akumas.of(world);
    const pending = api.spawn({
      akumaName: "worker",
      cwd: world,
      ...configured.placement,
    });
    let spawnSettled = false;
    void pending.then(() => { spawnSettled = true; }, () => { spawnSettled = true; });
    let result: Awaited<typeof pending>;
    try {
      const readyPath = join(emptyPublicationBarrier, "ready");
      await waitForCondition("empty Body publication barrier", () => existsSync(readyPath), {
        terminalState: settlementProbe(pending, () => "call settled before empty Body publication"),
      });
      const held = JSON.parse(readFileSync(readyPath, "utf8")) as { id: string };
      const whileHeld = await readHeart(pathsForAkumaId(world, parseAkumaId(held.id).id));
      assert.equal(whileHeld.latestBody?.end, undefined);
      assert.deepEqual(whileHeld.pending, []);
      assert.equal(spawnSettled, false, "spawn cannot return while its empty birth Body is running");

      writeFileSync(join(emptyPublicationBarrier, "release"), "release\n");
      result = await pending;
    } finally {
      const releasePath = join(emptyPublicationBarrier, "release");
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release\n");
      await pending.catch(() => undefined);
    }
    akumaId = result.akumaId;
    const asked = await api.ask({
      akuma: result.akumaId,
      body: "schema-call",
      schema: { type: "object" },
      signal: t.signal,
    });
    assert.equal(result.kind, "spawned");
    assert.equal(asked.kind, "answered");
    if (asked.kind !== "answered") assert.fail(JSON.stringify(asked));
    assert.deepEqual(asked.answer, { ok: true });
    let answeredTurn: `turn/${number}` | undefined;
    for await (const window of PublicAkuma.select(world, result.akumaId).stream()) {
      assert.deepEqual(window.rows.filter(row => row.kind === "tell").map(row => row.text), ["schema-call"]);
      assert.equal(window.rows.filter(row => row.kind === "turn").length, 1);
      assert.ok(!window.rows.some(row => row.kind === "call"));
      const outcome = window.rows.find(row => row.kind === "outcome");
      assert.ok(outcome?.outcome.kind === "answered");
      answeredTurn = `turn/${outcome.turnSequence}`;
      break;
    }

    // Reopening after Settings change must use the retained native recipe.
    writeFileSync(join(configured.home, "settings.json"), JSON.stringify({ providers: {} }));
    const reopened = PublicAkuma.select(await World.at(world), result.akumaId);
    await reopened.idle({ timeoutMs: 10_000 });
    const continued = await reopened.tell("continue", { wait: true, timeoutMs: 10_000 });
    assert.ok("state" in continued && continued.state === "done");
    assert.equal(continued.answer, '{"ok":true}');
    assert.deepEqual((await readSoul(pathsForAkumaId(world, result.akumaId)))?.provider.config, configured.config);
    assert.ok(answeredTurn);
    const fork = await api.fork({ akuma: result.akumaId, at: answeredTurn });
    assert.equal(fork.kind, "forked");
    if (fork.kind !== "forked") assert.fail(JSON.stringify(fork));
    assert.deepEqual((await readSoul(pathsForAkumaId(world, fork.childAkumaId)))?.provider.config, configured.config);
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      await departure.cleanup(operationFailed, { timeoutMs: 15_000 });
    } finally {
      restoreEmptyPublicationBarrier();
      departure.restore();
      restoreSquareLedger();
    }
  }
});

test("a Tell admitted while an empty Body is deciding to put down is still driven", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const barrier = join(raw.path, "idle-finish-barrier");
  mkdirSync(barrier);
  const departure = bodyReceiptFixture(t, raw.path);
  const restoreIdleBarrier = installAkumaBodyIdleFinishBarrier(barrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let birth: Promise<PublicAkuma> | undefined;
  let operationFailed = true;
  try {
    birth = PublicAkuma.birth("worker", { root: world, cwd: world, ...configured.placement });
    void birth.catch(() => undefined);
    await waitForCondition("Body idle-finish barrier", () => existsSync(join(barrier, "idle-ready")), {
      terminalState: settlementProbe(birth, () => "birth settled before its empty Body could finish"),
    });
    const child = (await Akumas.of(world).list()).rows?.[0];
    assert.ok(child);
    const paths = pathsForAkumaId(world, child.id);
    const terminalState = async () => {
      const body = (await readHeart(paths)).latestBody;
      const turn = body === null ? null : await readLatestTurnForBody(paths, body.sequence);
      if (turn?.end?.outcome.kind === "answered") return null;
      if (turn?.end !== undefined) return `Turn ${turn.sequence}: ${JSON.stringify(turn.end.outcome)}`;
      if (body?.hung !== undefined) return `Body ${body.sequence}: ${body.hung.diagnostic}`;
      return body?.end === undefined ? null : `Body ${body.sequence}: ${body.end}`;
    };
    await waitForCondition("Body periodic observation barrier", () => existsSync(join(barrier, "observation-ready")), {
      terminalState,
    });
    const admitted = await recordTell(paths, {
      kind: "tell",
      id: "late-tell",
      body: "answer",
      recordedAt: new Date().toISOString(),
    });
    assert.equal(admitted.kind, "recorded");
    writeFileSync(join(barrier, "release"), "release\n");
    await waitForCondition("late Tell binding after explicit refresh", async () =>
      (await readTell(paths, "late-tell"))?.binding !== undefined,
      { terminalState },
    );
    const tell = await readTell(paths, "late-tell");
    assert.ok(tell?.binding);
    const turnSequence = tell.binding.turnSequence;
    writeFileSync(join(barrier, "observation-release"), "release\n");
    await waitForCondition("exact late Tell Turn answer", async () =>
      (await readTurn(paths, turnSequence))?.end?.outcome.kind === "answered",
      { terminalState },
    );
    const turn = await readTurn(paths, turnSequence);
    assert.equal(turn?.end?.outcome.kind, "answered");
    if (turn?.end?.outcome.kind === "answered") assert.equal(turn.end.outcome.answer, '{"ok":true}');
    await birth;
    operationFailed = false;
  } finally {
    writeFileSync(join(barrier, "release"), "release\n");
    writeFileSync(join(barrier, "observation-release"), "release\n");
    await birth?.catch(() => undefined);
    try {
      await departure.cleanup(operationFailed, {
        timeoutMs: 60_000,
        expectRetainedEvidence: operationFailed,
      });
    } finally {
      restoreIdleBarrier();
      departure.restore();
      restoreSquareLedger();
    }
  }
});

test("Akumas.spawn preserves its child when initial Tell admission fails", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const departure = bodyReceiptFixture(t, raw.path);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let admissionCalls = 0;
  let operationFailed = true;
  const admitTell = AkumaOwner.prototype.admitTell;
  t.mock.method(AkumaOwner.prototype, "admitTell", async function (this: AkumaOwner, ...args: Parameters<typeof admitTell>) {
    admissionCalls += 1;
    const paths = pathsForAkumaId(world, this.id);
    assert.equal((await readHeart(paths)).latestBody?.end, "exited");
    const writer = new DatabaseSync(paths.heart);
    try {
      writer.exec("BEGIN IMMEDIATE");
      return await admitTell.apply(this, args);
    } finally {
      writer.close();
    }
  });
  try {
    const result = await Akumas.of(world).spawn({
      akumaName: "worker",
      body: "first Tell blocked by Heart writer",
      cwd: world,
      ...configured.placement,
      mode: "detach",
    });
    akumaId = result.akumaId;
    assert.equal(result.kind, "failed");
    if (result.kind !== "failed") assert.fail("expected initial Tell failure");
    assert.equal(result.failures[0].stage, "tell");
    if (result.failures[0].stage !== "tell") assert.fail("expected Tell stage");
    assert.match(result.failures[0].diagnostic, /database is locked/u);
    assert.equal(admissionCalls, 1);
    const child = PublicAkuma.select(world, result.akumaId);
    assert.equal((await child.status()).life, "asleep");
    const history = await child.history();
    assert.deepEqual(history.rows, []);
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      await departure.cleanup(operationFailed, { timeoutMs: 15_000 });
    } finally {
      departure.restore();
      restoreSquareLedger();
    }
  }
});

test("ordinary Akumas.spawn stays bound to its first Turn when a later Turn settles before observation", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const departure = bodyReceiptFixture(t, raw.path);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let observedTellId: string | undefined;
  let operationFailed = true;
  try {
    const result = await Akumas.of(world).spawn({
      akumaName: "worker",
      body: "ordinary-first-input",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      timeoutMs: 10_000,
      observe: {
        admitted: async (tell, id) => {
          observedTellId = tell.admission.tellId;
          const paths = pathsForAkumaId(world, id);
          await waitForCondition("the call's admitted Turn to settle", async () => {
            const persisted = await readTell(paths, tell.admission.tellId);
            if (persisted?.binding === undefined) return false;
            return (await readTurn(paths, persisted.binding.turnSequence))?.end !== undefined;
          });
          await waitForCondition("the call Body to release its leash", async () => {
            const available = await HeldAkumaLeash.try(paths);
            if (available === null) return false;
            available.release();
            return true;
          });
          const leash = await HeldAkumaLeash.try(paths);
          if (leash === null) throw new Error("settled call Body did not release its leash");
          try {
            const at = new Date().toISOString();
            const body = await leash.recordBody(paths, { leashTakenAt: at });
            const laterTellId = `${tell.admission.tellId}-later`;
            const laterTell = await recordTell(paths, {
              kind: "tell",
              id: laterTellId,
              body: "later input",
              recordedAt: at,
            });
            assert.equal(laterTell.kind, "recorded");
            const laterTurn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
            await bindTellsToTurn(paths, {
              turnSequence: laterTurn.sequence,
              tellIds: [laterTellId],
              boundAt: at,
            });
            const completedAt = new Date(Date.parse(at) + 1).toISOString();
            await endTurn(paths, {
              turnSequence: laterTurn.sequence,
              outcome: {
                kind: "answered",
                historyId: "later-call-history",
                session: { sessionId: "later-call-session" },
                answer: "later answer",
              },
              completedAt,
            });
            await finishBodyIfIdle(paths, {
              sequence: body.sequence,
              at: new Date(Date.parse(completedAt) + 1).toISOString(),
            });
          } finally {
            leash.release();
          }
        },
      },
    });
    assert.equal(result.input?.kind, "answered");
    assert.deepEqual(settledInput(result.input), { kind: "answered", answer: '{"ok":true}' });
    assert.equal(result.tellId, observedTellId);
    operationFailed = false;
  } finally {
    try {
      await departure.cleanup(operationFailed, { timeoutMs: 15_000 });
    } finally {
      departure.restore();
      restoreSquareLedger();
    }
  }
});

test("Archetype base chains refuse missing providers, malformed names, and cycles", async (context) => {
  const home = temporaryDirectory(context, "keiyaku-akuma-name-invalid-base-");
  mkdirSync(join(home, "akumas"));
  writeFileSync(join(home, "akumas", "missing.md"), "---\nbase: absent\n---\n");
  writeFileSync(join(home, "akumas", "malformed.md"), "---\nbase: 'bad/name'\n---\n");
  writeFileSync(join(home, "akumas", "a.md"), "---\nbase: b\n---\n");
  writeFileSync(join(home, "akumas", "b.md"), "---\nbase: a\n---\n");
  writeFileSync(join(home, "akumas", "noprov.md"), "---\nbase: empty\n---\n");
  writeFileSync(join(home, "akumas", "empty.md"), "---\n{}\n---\n");
  const settingsValue = await Settings.load({ home });
  await assert.rejects(
    loadPreparedArchetype({ name: "missing", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaNameError && error.message.includes("missing -> absent"),
  );
  await assert.rejects(
    loadPreparedArchetype({ name: "malformed", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaNameError && error.reason.includes("Akuma name"),
  );
  await assert.rejects(
    loadPreparedArchetype({ name: "a", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaNameError && error.message.includes("a -> b -> a"),
  );
  await assert.rejects(
    loadPreparedArchetype({ name: "noprov", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaNameError && error.message.includes("provider must be"),
  );
});

// Decode at the owner boundary: bad configuration does not need Git, a Body, or a provider process.
// The initiating local call must keep its Archetype-classified refusal even though
// the shared prepared-call executor performs provider admission.
