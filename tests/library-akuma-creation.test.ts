import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { AkumaArchetypeError, loadArchetype } from "../src/akuma/archetype.js";
import { akumaCallRequestCommands, type AkumaCallRequestChildLaunch } from "../src/akuma/call-request.js";
import { finishBodyIfIdle, HeldAkumaLeash, initializeHeart, readHeart, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, parseAkuId, pathsForAkuId } from "../src/akuma/identity.js";
import { Akuma as PublicAkuma, Schema } from "../src/akuma/index.js";
import { fleetRequestCommands, type FleetRequestPort } from "../src/akuma/fleet-request.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { repositoryAt } from "../src/git/repository.js";
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

async function assertBirthSettledAtTell(world: WorldRoot, akumaId: string): Promise<void> {
  const paths = pathsForAkuId(world, parseAkuId(akumaId).id);
  const heart = await readHeart(paths);
  assert.equal(heart.latestBody?.end, "exited");
  const leash = await HeldAkumaLeash.try(paths);
  assert.notEqual(leash, null, "schema Tell must observe the released birth leash");
  leash?.release();
}

test("local schema Keiyaku.call waits for its held empty Body before admitting its Tell", async (t) => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const schema = Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
  const bodyPidReceipt = join(raw.path, "body-pids");
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let operationFailed = true;
  let birthSettled = false;
  const wait = AkumaHandle.prototype.wait;
  const tell = PublicAkuma.prototype.tell;
  t.mock.method(AkumaHandle.prototype, "wait", async function (this: AkumaHandle, ...args: Parameters<typeof wait>) {
    const status = await wait.apply(this, args);
    birthSettled = true;
    return status;
  });
  t.mock.method(PublicAkuma.prototype, "tell", async function (this: PublicAkuma, ...args: Parameters<typeof tell>) {
    await assertBirthSettledAtTell(world, this.id);
    assert.equal(birthSettled, true, "schema Tell must await the prompt-free birth Body");
    return await tell.apply(this, args);
  });
  try {
    const pending = Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "schema-call",
      cwd: world,
      ...configured.placement,
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
    assert.deepEqual(result.schemaAnswer, { ok: true });
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
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const schema = Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
  const bodyPidReceipt = join(raw.path, "body-pids");
  const emptyPublicationBarrier = join(raw.path, "empty-publication-barrier");
  mkdirSync(emptyPublicationBarrier);
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreEmptyPublicationBarrier = installAkumaBodyEmptyPublicationBarrier(emptyPublicationBarrier);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let operationFailed = true;
  try {
    const pending = Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "zero-budget-after-birth",
      cwd: world,
      ...configured.placement,
      schema,
      timeoutMs: 0,
    });
    void pending.catch(() => undefined);
    const readyPath = join(emptyPublicationBarrier, "ready");
    await waitForFixtureFile(readyPath);
    const held = JSON.parse(readFileSync(readyPath, "utf8")) as { id: string };
    const result = await pending;
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") assert.equal(result.observation.reason, "deadline");
    assert.equal(result.schemaAnswer, undefined);
    assert.deepEqual((await readHeart(pathsForAkuId(world, parseAkuId(held.id).id))).pending, []);
    assert.equal((await readHeart(pathsForAkuId(world, parseAkuId(held.id).id))).latestBody?.end, undefined);
    operationFailed = false;
  } finally {
    try {
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

test("schema Keiyaku.call skips Tell after a non-asleep terminal birth", async (t) => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const schema = Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let akumaId: string | undefined;
  let tellCalls = 0;
  let operationFailed = true;
  t.mock.method(AkumaHandle.prototype, "wait", async function (this: AkumaHandle) {
    return {
      id: this.id,
      life: "killed",
      allowed: [],
      timeline: { kind: "idle", entries: [], omitted: 0, reportedChanges: [], reportedChangesOmitted: 0 },
    } as never;
  });
  t.mock.method(PublicAkuma.prototype, "tell", async function () {
    tellCalls += 1;
    throw new Error("schema Tell must not be admitted after a terminal birth");
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
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(result.observation.kind, "detached");
    assert.equal(tellCalls, 0);
    assert.deepEqual((await readHeart(pathsForAkuId(world, parseAkuId(result.akuma).id))).pending, []);
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

test("forwarded schema Keiyaku.call waits for its empty Body before admitting its Tell", async (t) => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const schema = Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
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
      ...configured.placement,
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
    assert.deepEqual(result.schemaAnswer, { ok: true });
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

test("forwarded schema Keiyaku.call's deadline cancels its held birth Body request", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const schema = Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
  const slow = slowEmptyPublicationBody();
  const { pump, leash } = await requestPump(world, slow.spawn);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  try {
    const pending = routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "forwarded-deadline-before-birth-body-settles",
      cwd: world,
      ...configured.placement,
      schema,
      timeoutMs: 20,
    });
    const body = await slow.started;
    const result = await pending;
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") assert.equal(result.observation.reason, "deadline");
    assert.equal(result.schemaAnswer, undefined);
    assert.equal((await readHeart(body.paths)).latestBody?.end, undefined);
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

test("schema Keiyaku.call spends its one deadline through a delayed schema answer", async (t) => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const schema = Schema.json(
    { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
    (value) => value as { ok: boolean },
  );
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  const tell = PublicAkuma.prototype.tell;
  let schemaSignal: AbortSignal | undefined;
  t.mock.method(PublicAkuma.prototype, "tell", async function (this: PublicAkuma, ...args: Parameters<typeof tell>) {
    const options = args[1];
    schemaSignal = options !== undefined && "signal" in options ? options.signal : undefined;
    assert.ok(schemaSignal instanceof AbortSignal, "bounded schema Tell must receive the call deadline signal");
    return await new Promise<never>((_resolve, reject) => {
      schemaSignal!.addEventListener("abort", () => reject(schemaSignal!.reason), { once: true });
    });
  });
  let operationFailed = true;
  try {
    const result = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "schema-deadline",
      cwd: world,
      ...configured.placement,
      schema,
      timeoutMs: 5_000,
    });
    assert.equal(result.schemaAnswer, undefined);
    assert.deepEqual(result.observation.kind, "observed");
    if (result.observation.kind === "observed") assert.equal(result.observation.reason, "completed");
    assert.equal(schemaSignal?.aborted, true);
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

async function requestPump(root: WorldRoot, spawn: RequestSpawn = defaultRequestSpawn) {
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
      akumaCallRequestCommands({ world: root, paths: parent.paths, parent: soul, spawn }),
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
