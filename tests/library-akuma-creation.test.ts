import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier, waitForCondition } from "./support/process.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { AkumaArchetypeError, loadArchetype } from "../src/akuma/archetype.js";
import {
  akumaCallRequestCommands,
  type AkumaCallRequestChildLaunch,
  type InitialTellAdmissionRequest,
} from "../src/akuma/call-request.js";
import { admitCallInitialTell, type CallInitialTellAdmission } from "../src/akuma/call-initial-tell.js";
import {
  beginTurn,
  bindTellsToTurn,
  endTurn,
  finishBodyIfIdle,
  HeldAkumaLeash,
  initializeHeart,
  projectTell,
  readHeart,
  readSoul,
  readTell,
  readTurn,
  recordTell,
  type Soul,
} from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, parseAkuId, pathsForAkuId } from "../src/akuma/identity.js";
import { Akuma as PublicAkuma, Schema } from "../src/akuma/index.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { fleetRequestCommands, type FleetRequestPort } from "../src/akuma/fleet-request.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { repositoryAt } from "../src/git/repository.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv, type ParsedExecution } from "../src/cli/parse.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { bodyRequestExecution, Keiyaku, Repo, World, settings } from "../src/index.js";
import {
  cleanupSpawnCapableFixture,
  installAkumaBodyEmptyPublicationBarrier,
  installAkumaBodyPidReceipt,
  waitForFixtureFile,
} from "./support/process.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import type { WorldRoot } from "../src/world.js";
import { AkumaComposition as Akuma, AkumaHandle, isolateSquareFixtureLedger } from "./support/akuma-composition.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function executable(argv: readonly string[]): ParsedExecution {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected executable command");
  return parsed;
}

async function repositoryFixture() {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return { raw, repo: await Repo.at({ path: raw.path }), git: await repositoryAt(raw.path) };
}

async function directArchetypeSettings(root: string) {
  const home = join(root, ".direct-settings");
  const executable = join(root, "fake-codex");
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: local\n---\nWork.\n");
  writeFileSync(join(home, "akuma", "restricted.md"), "---\nprovider: local\nallowed:\n  - task.add\n---\nWork.\n");
  writeFileSync(join(home, "akuma", "empty.md"), "---\nprovider: local\nallowed: []\n---\nWork.\n");
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({
      providers: { local: { kind: "codex-app-server", executable } },
    }),
  );
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
      "const reply = (message, result) => send({ id: message.id, result });",
      "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
      "lines.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') return reply(message, {});",
      "  if (message.method === 'initialized') return;",
      "  if (message.method === 'thread/start') return reply(message, { thread: { id: 'thread-1' } });",
      "  if (message.method !== 'turn/start') return;",
      "  reply(message, { turn: { id: 'turn-1' } });",
      "  send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{\"ok\":true}' } } });",
      "  send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
      "});",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  const value = await settings({ root, home });
  return { home, value, placement: { home, settings: value } };
}

async function directCallFixture() {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  return { raw, world, configured: await directArchetypeSettings(world) };
}

function okSchema() {
  return Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
}

function slowEmptyPublicationBody() {
  let held:
    | Readonly<{
        bodySequence: number;
        leash: HeldAkumaLeash;
        paths: AkumaCallRequestChildLaunch["paths"];
        resolveExit: (exit: Awaited<OwnedProcess["exited"]>) => void;
      }>
    | undefined;
  const { promise: started, resolve: resolveStarted } =
    promiseBarrier<Readonly<{ paths: AkumaCallRequestChildLaunch["paths"]; bodySequence: number }>>();
  let released = false;
  const release = async (): Promise<void> => {
    if (released || held === undefined) return;
    released = true;
    await finishBodyIfIdle(held.paths, { sequence: held.bodySequence, at: "2026-09-10T00:00:02.000Z" });
    held.leash.release();
    held.resolveExit({ code: 0, signal: null, log: { path: "/tmp/slow-empty-body.log", from: 0, to: 0 } });
  };

  return {
    started,
    spawn: async (launch: AkumaCallRequestChildLaunch): Promise<OwnedProcess> => {
      const leash = (await HeldAkumaLeash.try(launch.paths))!;
      await leash.birth(launch.paths, { ...launch.seed, createdAt: "2026-09-10T00:00:00.000Z" });
      const body = await leash.recordBody(launch.paths, { leashTakenAt: "2026-09-10T00:00:01.000Z" });
      const { promise: exited, resolve: resolveExit } = promiseBarrier<Awaited<OwnedProcess["exited"]>>();
      held = { paths: launch.paths, bodySequence: body.sequence, leash, resolveExit };
      resolveStarted({ paths: launch.paths, bodySequence: body.sequence });
      return {
        pid: 4242,
        exited,
        terminate: async () => await release(),
        release: () => {},
      };
    },
    release,
  };
}

test("local schema Keiyaku.call waits for its held empty Body before admitting its Tell", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let operationFailed = true;
  try {
    const pending = Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "schema-call",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      schema,
    });
    void pending.catch(() => undefined);
    let result: Awaited<typeof pending>;
    try {
      const readyPath = join(emptyPublicationBarrier, "ready");
      await waitForFixtureFile(readyPath);
      const held = JSON.parse(readFileSync(readyPath, "utf8")) as { id: string };
      const whileHeld = await readHeart(pathsForAkuId(world, parseAkuId(held.id).id));
      assert.equal(whileHeld.latestBody?.end, undefined);
      assert.deepEqual(whileHeld.pending, []);

      writeFileSync(join(emptyPublicationBarrier, "release"), "release\n");
      result = await pending;
    } finally {
      const releasePath = join(emptyPublicationBarrier, "release");
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release\n");
      await pending.catch(() => undefined);
    }
    akumaId = result.akuma;
    assert.equal(result.observation.kind, "observed");
    if (result.observation.kind === "observed")
      assert.deepEqual(result.observation.observation, { reason: "answered", answer: { ok: true } });
    const history = await PublicAkuma.select(world, result.akuma).history();
    const tells = history.rows.filter((row) => row.kind === "tell");
    assert.equal(tells.length, 1);
    assert.equal(tells[0]?.kind, "tell");
    if (tells[0]?.kind === "tell") assert.equal(tells[0].text, "schema-call");
    assert.equal(history.rows.filter((row) => row.kind === "turn").length, 1);
    assert.equal(
      history.rows.some((row) => row.kind === "call"),
      false,
    );
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      const cleanup = await cleanupSpawnCapableFixture({
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
      if (cleanup.kind === "retained") t.diagnostic(`retained fixture ${raw.path}: ${cleanup.diagnostic}`);
    } finally {
      restoreEmptyPublicationBarrier();
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("local schema Keiyaku.call starts its zero observation budget after birth", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let wake: Promise<unknown> | undefined;
  const admitInitialTell = AkumaHandle.prototype.admitInitialTell;
  t.mock.method(
    AkumaHandle.prototype,
    "admitInitialTell",
    async function (this: AkumaHandle, ...args: Parameters<typeof admitInitialTell>) {
      const admitted = await admitInitialTell.apply(this, args);
      if (admitted.kind === "admitted") wake = admitted.wake;
      return admitted;
    },
  );
  let operationFailed = true;
  try {
    const pending = Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "zero-budget-after-birth",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      schema,
      timeoutMs: 0,
    });
    void pending.catch(() => undefined);
    const readyPath = join(emptyPublicationBarrier, "ready");
    await waitForFixtureFile(readyPath);
    const held = JSON.parse(readFileSync(readyPath, "utf8")) as { id: string };
    const child = parseAkuId(held.id).id;
    assert.equal((await readHeart(pathsForAkuId(world, child))).latestBody?.end, undefined);
    writeFileSync(join(emptyPublicationBarrier, "release"), "release\n");
    const result = await pending;
    akumaId = result.akuma;
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") {
      assert.deepEqual(result.observation.observation, { reason: "deadline" });
      assert.equal(result.observation.tell.row.text, "zero-budget-after-birth");
    }
    const history = await PublicAkuma.select(world, result.akuma).history();
    const tells = history.rows.filter((row) => row.kind === "tell");
    assert.equal(tells.length, 1);
    assert.equal(tells[0]?.kind === "tell" ? tells[0].text : undefined, "zero-budget-after-birth");
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      await wake?.catch(() => undefined);
      const releasePath = join(emptyPublicationBarrier, "release");
      if (!existsSync(releasePath)) writeFileSync(releasePath, "release\n");
      const cleanup = await cleanupSpawnCapableFixture({
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
      if (cleanup.kind === "retained") t.diagnostic(`retained fixture ${raw.path}: ${cleanup.diagnostic}`);
    } finally {
      restoreEmptyPublicationBarrier();
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("schema Keiyaku.call preserves its child when initial Tell admission fails", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let admissionCalls = 0;
  let operationFailed = true;
  t.mock.method(AkumaHandle.prototype, "admitInitialTell", async function (this: AkumaHandle) {
    admissionCalls += 1;
    return {
      kind: "birth-failed" as const,
      diagnostic: `Akuma ${this.id} prompt-free birth did not settle cleanly`,
    };
  });
  try {
    const result = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "terminal-birth-schema-call",
      cwd: world,
      ...configured.placement,
      mode: "detach",
      schema,
    });
    akumaId = result.akuma;
    assert.equal(result.observation.kind, "failed");
    if (result.observation.kind === "failed") assert.match(result.observation.failure.diagnostic, /did not settle cleanly/u);
    assert.equal(admissionCalls, 1);
    const history = await PublicAkuma.select(world, result.akuma).history();
    assert.equal(history.rows.filter((row) => row.kind === "tell").length, 0);
    operationFailed = false;
  } finally {
    try {
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      const cleanup = await cleanupSpawnCapableFixture({
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
      if (cleanup.kind === "retained") t.diagnostic(`retained fixture ${raw.path}: ${cleanup.diagnostic}`);
    } finally {
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("forwarded schema Keiyaku.call waits for birth and retains readonly evidence", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const slow = slowEmptyPublicationBody();
  const { pump, leash } = await requestPump(world, slow.spawn);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let operationFailed = true;
  try {
    const pending = routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "forwarded-schema-call",
      cwd: world,
      readonly: true,
      ...configured.placement,
      mode: "wait",
      schema,
    });
    const body = await slow.started;
    const whileHeld = await readHeart(body.paths);
    assert.equal(whileHeld.latestBody?.sequence, body.bodySequence);
    assert.equal(whileHeld.latestBody?.end, undefined);
    assert.deepEqual(whileHeld.pending, []);

    await slow.release();
    const result = await pending;
    akumaId = result.akuma;
    assert.equal(result.readonly?.enforcement, "native");
    assert.equal(result.observation.kind, "observed");
    if (result.observation.kind === "observed")
      assert.deepEqual(result.observation.observation, { reason: "answered", answer: { ok: true } });
    const history = await PublicAkuma.select(world, result.akuma).history();
    const tells = history.rows.filter((row) => row.kind === "tell");
    assert.equal(tells.length, 1);
    assert.equal(tells[0]?.kind, "tell");
    if (tells[0]?.kind === "tell") assert.equal(tells[0].text, "forwarded-schema-call");
    assert.equal(history.rows.filter((row) => row.kind === "turn").length, 1);
    assert.equal(
      history.rows.some((row) => row.kind === "call"),
      false,
    );
    operationFailed = false;
  } finally {
    try {
      await slow.release();
      if (akumaId !== undefined)
        await PublicAkuma.select(world, akumaId)
          .kill()
          .catch(() => undefined);
      const cleanup = await cleanupSpawnCapableFixture({
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
      if (cleanup.kind === "retained") t.diagnostic(`retained fixture ${raw.path}: ${cleanup.diagnostic}`);
    } finally {
      await pump.close();
      leash.release();
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("forwarded schema Keiyaku.call admits its initial Tell after held birth before a zero-budget deadline", async () => {
  const { raw, world, configured } = await directCallFixture();
  const schema = okSchema();
  const slow = slowEmptyPublicationBody();
  const { pump, leash } = await requestPump(world, slow.spawn);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  try {
    const pending = routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "forwarded-deadline-after-birth",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      schema,
      timeoutMs: 0,
    });
    const body = await slow.started;
    assert.equal((await readHeart(body.paths)).latestBody?.end, undefined);
    await slow.release();
    const result = await pending;
    assert.equal(result.observation.kind, "observed");
    if (result.observation.kind === "observed") {
      assert.deepEqual(result.observation.observation, { reason: "deadline" });
      assert.equal(result.observation.tell.row.text, "forwarded-deadline-after-birth");
    }
    const history = await PublicAkuma.select(world, result.akuma).history();
    assert.equal(history.rows.filter((row) => row.kind === "tell").length, 1);
  } finally {
    try {
      await slow.release();
      rmSync(raw.path, { recursive: true, force: true });
    } finally {
      await pump.close();
      leash.release();
      restoreSquareLedger();
    }
  }
});

test("forwarded Keiyaku.call spends its wait budget from the child's Tell admission", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  const slow = slowEmptyPublicationBody();
  let admittedAtPerf = Number.NaN;
  let remainingBudget: number | undefined;
  const tellOutcome = AkumaHandle.prototype.tellOutcome;
  t.mock.method(
    AkumaHandle.prototype,
    "tellOutcome",
    async function (this: AkumaHandle, tellId: string, options?: Parameters<AkumaHandle["tellOutcome"]>[1]) {
      remainingBudget = options?.timeoutMs;
      return await tellOutcome.call(this, tellId, options);
    },
  );
  const { pump, leash } = await requestPump(world, slow.spawn, async ({ id, initialTell, signal }) => {
    const admission = await admitCallInitialTell({
      world,
      id,
      initialTell,
      ...(signal === undefined ? {} : { signal }),
      wake: async (tell) => ({
        admission: { tellId: tell.id, fact: "recorded" },
        row: projectTell(tell),
        wake: { kind: "held" },
      }),
    });
    if (admission.kind === "admitted") {
      admittedAtPerf = performance.now();
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
    }
    return admission;
  });
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  try {
    const pending = routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "forwarded-budget-after-admission",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      timeoutMs: 250,
    });
    await slow.started;
    await slow.release();
    const result = await pending;
    const elapsed = performance.now() - admittedAtPerf;
    assert.equal(result.observation.kind, "observed", JSON.stringify(result.observation));
    if (result.observation.kind === "observed") assert.deepEqual(result.observation.observation, { reason: "deadline" });
    assert.equal(remainingBudget, 0, `forwarding delay consumed the deadline after ${elapsed}ms from Tell admission`);
  } finally {
    try {
      await slow.release();
      await pump.close();
      leash.release();
    } finally {
      rmSync(raw.path, { recursive: true, force: true });
      restoreSquareLedger();
    }
  }
});

test("ordinary Keiyaku.call stays bound to its first Turn when a later Turn settles before observation", async (t) => {
  const { raw, world, configured } = await directCallFixture();
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let observedTellId: string | undefined;
  let operationFailed = true;
  try {
    const result = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "ordinary-first-input",
      cwd: world,
      ...configured.placement,
      mode: "wait",
      timeoutMs: 10_000,
      observe: {
        admitted: async (tell, id) => {
          observedTellId = tell.admission.tellId;
          const paths = pathsForAkuId(world, id);
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
    assert.equal(result.structured, undefined);
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") {
      assert.deepEqual(result.observation.observation, { reason: "answered", answer: '{"ok":true}' });
      assert.equal(result.observation.tell.admission.tellId, observedTellId);
    }
    operationFailed = false;
  } finally {
    try {
      const cleanup = await cleanupSpawnCapableFixture({
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
      if (cleanup.kind === "retained") t.diagnostic(`retained fixture ${raw.path}: ${cleanup.diagnostic}`);
    } finally {
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

async function defaultRequestSpawn(launch: AkumaCallRequestChildLaunch): Promise<void> {
  const child = (await HeldAkumaLeash.try(launch.paths))!;
  await child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-11T00:00:02.000Z" });
  child.release();
}

type RequestSpawn = (launch: AkumaCallRequestChildLaunch) => Promise<OwnedProcess | void>;

async function requestPump(
  root: WorldRoot,
  spawn: RequestSpawn = defaultRequestSpawn,
  admitInitialTell?: (input: InitialTellAdmissionRequest) => Promise<CallInitialTellAdmission>,
) {
  const parent = await allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  await initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(parent.paths))!;
  await leash.birth(parent.paths, soul);
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    allowed: soul.allowed,
    bodySequence: 1,
    now: () => "2026-08-11T00:00:01.000Z",
    signal: new AbortController().signal,
    commands: composeRequestCommands(
      akumaCallRequestCommands({
        world: root,
        paths: parent.paths,
        parent: soul,
        spawn,
        admitInitialTell:
          admitInitialTell ??
          (async ({ id, initialTell, signal }) =>
            await new AkumaHandle(id, root).admitInitialTell(initialTell, { signal })),

      }),
      fleetRequestCommands({
        wait: async () => {
          throw new Error("unexpected forwarded wait");
        },
        tell: async () => {
          throw new Error("unexpected forwarded Tell");
        },
        tellAnswer: async (input) =>
          await PublicAkuma.select(root, input.target).tell(input.body, {
            schema: Schema.json(JSON.parse(input.schemaJson) as Record<string, unknown>, (value) => value),
            ...(input.interrupt === undefined ? {} : { interrupt: input.interrupt }),
          }),
        kill: async () => {
          throw new Error("unexpected forwarded kill");
        },
      } satisfies FleetRequestPort),
    ),
  });
  return { pump, leash };
}

test("forwarded call preserves the born child when its exact initial Tell receipt is absent", async () => {
  const { raw, world, configured } = await directCallFixture();
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  const { pump, leash } = await requestPump(world, defaultRequestSpawn, async () => ({
    kind: "birth-failed",
    diagnostic: "initial Tell admission failed after child birth",
  }));
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  try {
    const result = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "forwarded-partial-birth",
      cwd: world,
      ...configured.placement,
      mode: "detach",
    });
    assert.equal(result.observation.kind, "failed");
    if (result.observation.kind === "failed") {
      assert.equal(result.observation.tellId.length > 0, true);
      assert.match(result.observation.failure.diagnostic, /missing from Heart/u);
      assert.equal(result.observation.tell, undefined);
    }
    assert.equal((await PublicAkuma.select(world, result.akuma).history()).rows.some((row) => row.kind === "tell"), false);
  } finally {
    try {
      await pump.close();
      leash.release();
    } finally {
      rmSync(raw.path, { recursive: true, force: true });
      restoreSquareLedger();
    }
  }
});

test("Contract association never selects the Akuma execution workdir", async (t) => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let operationFailed = true;
  let bound: Awaited<ReturnType<typeof Keiyaku.bind>> | undefined;
  const environment = { ...process.env };
  delete environment[AKUMA_REQUESTS_ENV];
  try {
    bound = await Keiyaku.bind({
      repo,
      markdown: contractMarkdown("Akuma execution placement", {
        Context: "A Contract association and a call execution directory are separate inputs.",
        Objective: "Contract association never selects the Akuma execution workdir.",
        Design: "Keep association in Dispatch and placement in the explicit execution directory.",
        Region: "```\nsrc/**\n```",
        Criteria: "### Placement\nThe invocation directory stands without an explicit workdir.",
      }),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    const managedId = (await bound.keiyaku.state()).id;
    const appointment = await readManagedWorktreeAppointment(git, managedId);
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = 'appointed'");
    if (appointment.kind !== "appointed") return;

    const invocationCwd = realpathSync(raw.path);
    const implicit = await invoke(executable(["-C", ".", "call", "worker", "--contract", managedId, "-"]), {
      cwd: raw.path,
      environment: { ...environment, KEIYAKU_HOME: configured.home },
      readStdin: async () => "implicit placement",
    });
    assert.ok("kind" in implicit && implicit.kind === "akuma" && implicit.action === "call");
    if (!("kind" in implicit) || implicit.kind !== "akuma" || implicit.action !== "call") return;
    assert.deepEqual(implicit.result.execution, { cwd: invocationCwd, source: "input" });
    assert.notEqual(implicit.result.execution.cwd, appointment.path);
    assert.equal(implicit.result.dispatch.kind, "dispatched");
    if (implicit.result.dispatch.kind === "dispatched")
      assert.equal(implicit.result.dispatch.dispatch.contractId, managedId);
    assert.equal((await readSoul(pathsForAkuId(world, implicit.result.akuma)))?.cwd, invocationCwd);

    const explicitDir = join(raw.path, "explicit-workdir");
    mkdirSync(explicitDir);
    const explicit = await invoke(
      executable(["-C", ".", "call", "worker", "--contract", managedId, "--workdir", "explicit-workdir", "-"]),
      {
        cwd: raw.path,
        environment: { ...environment, KEIYAKU_HOME: configured.home },
        readStdin: async () => "explicit placement",
      },
    );
    assert.ok("kind" in explicit && explicit.kind === "akuma" && explicit.action === "call");
    if (!("kind" in explicit) || explicit.kind !== "akuma" || explicit.action !== "call") return;
    assert.deepEqual(explicit.result.execution, { cwd: realpathSync(explicitDir), source: "input" });
    assert.equal(explicit.result.dispatch.kind, "dispatched");
    operationFailed = false;
  } finally {
    try {
      await bound?.keiyaku.abandon({ hooks: { create: [], destroy: [] } }).catch(() => undefined);
      const cleanup = await cleanupSpawnCapableFixture({
        fixturePath: raw.path,
        pidReceiptPath: bodyPidReceipt,
        timeoutMs: 15_000,
        operationFailed,
      });
      if (cleanup.kind === "retained") t.diagnostic(`retained fixture ${raw.path}: ${cleanup.diagnostic}`);
    } finally {
      restoreBodyPidReceipt();
      restoreSquareLedger();
    }
  }
});

test("package-root World inputs reject a forged JavaScript coordinate before effects", async (context) => {
  const root = await World.at(temporaryDirectory(context, "keiyaku-library-world-proof-"));
  const forged = `${root}/.`;
  await assert.rejects(
    Keiyaku.call({ path: forged as never, archetype: "worker", body: "must not start" }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Keiyaku.fork({ path: forged as never, akuma: "aku/worker/1234abcd", at: "turn/1" }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Keiyaku.ls({ query: { kind: "tasks" }, path: forged as never }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Keiyaku.status({ path: forged as never, akuma: "aku/worker/1234abcd" }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Keiyaku.wait({ path: forged as never, akuma: ["aku/worker/1234abcd"], completion: "all" }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Keiyaku.tell({ path: forged as never, akuma: "aku/worker/1234abcd", body: "must not tell" }),
    /canonical physical directory/u,
  );
  await assert.rejects(
    Keiyaku.kill({ path: forged as never, akuma: ["aku/worker/1234abcd"] }),
    /canonical physical directory/u,
  );
  assert.equal(existsSync(join(root, ".keiyaku", "akuma")), false);
});

test("Archetype base chains refuse missing providers, malformed names, and cycles", async (context) => {
  const home = temporaryDirectory(context, "keiyaku-akuma-archetype-invalid-base-");
  mkdirSync(join(home, "akuma"));
  writeFileSync(join(home, "akuma", "missing.md"), "---\nbase: absent\n---\n");
  writeFileSync(join(home, "akuma", "malformed.md"), "---\nbase: 'bad/name'\n---\n");
  writeFileSync(join(home, "akuma", "a.md"), "---\nbase: b\n---\n");
  writeFileSync(join(home, "akuma", "b.md"), "---\nbase: a\n---\n");
  writeFileSync(join(home, "akuma", "noprov.md"), "---\nbase: empty\n---\n");
  writeFileSync(join(home, "akuma", "empty.md"), "---\n{}\n---\n");
  const settingsValue = await settings({ home });
  await assert.rejects(
    loadArchetype({ name: "missing", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.message.includes("missing -> absent"),
  );
  await assert.rejects(
    loadArchetype({ name: "malformed", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.reason.includes("Akuma name"),
  );
  await assert.rejects(
    loadArchetype({ name: "a", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.message.includes("a -> b -> a"),
  );
  await assert.rejects(
    loadArchetype({ name: "noprov", home, settings: settingsValue }),
    (error: unknown) => error instanceof AkumaArchetypeError && error.message.includes("provider must be"),
  );
});

// Decode at the owner boundary: bad configuration does not need Git, a Body, or a provider process.
test("Archetype and call allowed inputs refuse malformed values before allocation", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-allowed-input-");
  const home = join(root, "home");
  mkdirSync(join(home, "akuma"), { recursive: true });
  const value = await settings({ root, home });
  const world = await World.at(root);
  const runtime = Akuma.of(world, { home, settings: value });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  for (const [allowed, expected] of [
    [["akuma.unknown"], /unknown action/u],
    [["akuma.call", "akuma.call"], /duplicate action/u],
    [[1], /unknown action/u],
  ] as const) {
    const yaml = allowed.map((action) => `  - ${action}\n`).join("");
    writeFileSync(join(home, "akuma", "invalid.md"), `---\nprovider: claude\nallowed:\n${yaml}---\nWork.\n`);
    await assert.rejects(loadArchetype({ name: "invalid", home, settings: value }), expected);
    await assert.rejects(runtime.call({ archetype: "worker", body: "invalid", allowed: allowed as never }), expected);
  }
  assert.deepEqual((await runtime.list()).rows, []);
});
