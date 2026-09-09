import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type AkumaCallInput } from "../src/akuma/akuma.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { AkumaArchetypeError, listArchetypeDefinitions, loadArchetype } from "../src/akuma/archetype.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { akumaCallRequestCommands, type AkumaCallRequestChildLaunch } from "../src/akuma/call-request.js";
import {
  finishBodyIfIdle,
  HeldAkumaLeash,
  initializeHeart,
  readHeart,
  readSoul,
  type Soul,
} from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, parseAkuId, pathsForAkuId } from "../src/akuma/identity.js";
import { Akuma as PublicAkuma, Schema } from "../src/akuma/index.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { AKUMA_REQUESTS_ENV, createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { fleetRequestCommands, type FleetRequestPort } from "../src/akuma/fleet-request.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { moveAlias, resolveAlias } from "../src/alias/index.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv, type ParsedExecution } from "../src/cli/parse.js";
import { publishDispatch, readDispatch } from "../src/dispatch/index.js";
import {
  GIT_REF,
  readGit,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeCommit,
} from "../src/git/repository.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { bodyRequestExecution, Keiyaku, Repo, World, settings } from "../src/index.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import {
  cleanupSpawnCapableFixture,
  installAkumaBodyEmptyPublicationBarrier,
  installAkumaBodyPidReceipt,
  waitForFixtureFile,
} from "./support/process.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import type { WorldRoot } from "../src/world.js";
import {
  AkumaComposition as Akuma,
  AkumaHandle,
  akumaCallExecution,
  isolateSquareFixtureLedger,
} from "./support/akuma-composition.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";

function markdown(title: string): string {
  return contractMarkdown(title, {
    Context: "context",
    Objective: "objective",
    Design: "design",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: "### C1\ncriterion\n",
  });
}

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

async function archetypeSettings(root: string) {
  const home = join(root, ".test-settings");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(home, "akuma", "reviewer.md"), "---\nprovider: claude\nreadonly: true\n---\nReview only.\n");
  const value = await settings({ root, home });
  return { home, value, placement: { home, settings: value } };
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
  let resolveStarted!: (value: Readonly<{ paths: AkumaCallRequestChildLaunch["paths"]; bodySequence: number }>) => void;
  const started = new Promise<Readonly<{ paths: AkumaCallRequestChildLaunch["paths"]; bodySequence: number }>>(
    (resolve) => {
      resolveStarted = resolve;
    },
  );
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
      let resolveExit!: (exit: Awaited<OwnedProcess["exited"]>) => void;
      const exited = new Promise<Awaited<OwnedProcess["exited"]>>((resolve) => {
        resolveExit = resolve;
      });
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

async function directBirthSoul(akuma: ReturnType<typeof Akuma.of>, input: AkumaCallInput): Promise<Soul> {
  const born = await akuma.beginCall(input, { initiatorCwd: process.cwd() });
  assert.equal(born.kind, "born");
  if (born.kind !== "born") throw new Error("direct call unexpectedly entered the Body Request path");
  await driveAkumaBody({ paths: born.allocated.paths, seed: born.seed });
  const soul = await readSoul(born.allocated.paths);
  assert.notEqual(soul, null);
  return soul!;
}

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

test("package-root World inputs reject a forged JavaScript coordinate before effects", async () => {
  const root = await World.at(mkdtempSync(join(tmpdir(), "keiyaku-library-world-proof-")));
  const forged = `${root}/.`;
  try {
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Keiyaku.call awaits admitted generic signal delivery after admission", async () => {
  const { raw, repo } = await repositoryFixture();
  const world = await World.at(raw.path);
  const trace = join(raw.path, "called.json");
  const ready = join(raw.path, "called.ready");
  const started = join(raw.path, "called.started");
  const releaseKey = `__keiyaku_test_called_release_${process.pid}`;
  const releasePlugin = (): void => {
    const release = (globalThis as Record<string, unknown>)[releaseKey];
    if (typeof release === "function") (release as () => void)();
  };
  mkdirSync(join(raw.path, ".keiyaku"), { recursive: true });
  mkdirSync(join(raw.path, "plugins"), { recursive: true });
  writeFileSync(
    join(raw.path, "plugins", "called.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      "export default {",
      '  manifest: { id: "called", apiVersion: 1 },',
      '  activate(context) { writeFileSync(context.config.ready, "ready"); return { signals: { "akuma.called": async (signal) => { await new Promise((resolve) => { globalThis[context.config.releaseKey] = resolve; writeFileSync(context.config.started, "started"); }); delete globalThis[context.config.releaseKey]; writeFileSync(context.config.trace, JSON.stringify(signal)); } } }; },',
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: { called: { package: "./plugins/called.mjs", config: { trace, ready, started, releaseKey } } },
    }),
  );
  const configured = await archetypeSettings(world);
  await pluginRuntime({ world, settings: configured.value });
  const { pump, leash } = await requestPump(world);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const activationDeadline = Date.now() + 1_000;
  while (!existsSync(ready)) {
    if (Date.now() >= activationDeadline) throw new Error("timed out waiting for called plugin activation");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Call plugin signal"), workspace: "worktree" });
  const contractId = (await bound.keiyaku.state()).id;
  try {
    const pending = routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "called",
      ...configured.placement,
      contract: bound.keiyaku,
      cwd: raw.path,
      mode: "detach",
    });
    const deadline = Date.now() + 1_000;
    while (!existsSync(started)) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for called plugin handler");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    assert.equal(completed, false);
    releasePlugin();
    const result = await pending;
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
      kind: "akuma.called",
      akumaId: result.akuma,
      callerAkumaId: "aku/parent/1234abcd",
      contractId,
    });
  } finally {
    releasePlugin();
    delete (globalThis as Record<string, unknown>)[releaseKey];
    await pump.close();
    leash.release();
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Keiyaku.call keeps optional Dispatch and Alias stages honest", async () => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = await requestPump(world);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const independent = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "independent",
      ...configured.placement,
    });
    assert.deepEqual(independent.dispatch, { kind: "none" });
    assert.deepEqual(independent.alias, { kind: "none" });
    assert.deepEqual(independent.execution, { cwd: world, source: "caller" });
    assert.equal(independent.observation.kind, "observed");
    assert.equal(await readDispatch(git, independent.akuma), null);

    const bound = await Keiyaku.bind({ repo, markdown: markdown("Akuma dispatch"), workspace: "worktree" });
    const owner = (await bound.keiyaku.state()).id;
    const alias = parseAkumaAlias("@worker");
    const executionCwd = join(raw.path, "nested-worktree");
    mkdirSync(executionCwd);
    const invoked = await invoke(
      executable([
        "-C",
        executionCwd,
        "call",
        "worker",
        "--repo",
        "..",
        "--contract",
        owner,
        "--workdir",
        ".",
        "--alias",
        alias,
        "-",
      ]),
      {
        environment: { ...process.env, KEIYAKU_HOME: configured.home },
        readStdin: async () => "associated",
      },
    );
    assert.equal("kind" in invoked && invoked.kind, "akuma");
    if (!("kind" in invoked) || invoked.kind !== "akuma" || invoked.action !== "call") return;
    const associated = invoked.result;
    assert.equal(associated.dispatch.kind, "dispatched");
    if (associated.dispatch.kind !== "dispatched") return;
    assert.equal(associated.dispatch.dispatch.contractId, owner);
    assert.deepEqual(await readDispatch(git, associated.akuma), associated.dispatch.dispatch);
    assert.deepEqual(associated.alias, {
      kind: "aliased",
      alias: { alias, akuId: associated.akuma },
      previous: null,
    });
    assert.equal(associated.observation.kind, "observed");
    assert.deepEqual(associated.execution, { cwd: realpathSync(executionCwd), source: "input" });
    assert.equal((await readSoul(pathsForAkuId(world, associated.akuma)))?.cwd, realpathSync(executionCwd));

    writeFileSync(join(raw.path, ".keiyaku", "akuma", "alias.json"), "broken\n");
    const partial = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "partial",
      ...configured.placement,
      contract: bound.keiyaku,
      alias,
      cwd: executionCwd,
    });
    assert.equal(partial.dispatch.kind, "dispatched");
    assert.equal(partial.alias.kind, "failed");
    assert.equal(partial.observation.kind, "observed");
    assert.notEqual(await readDispatch(git, partial.akuma), null);

    const detached = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "detached",
      ...configured.placement,
      mode: "detach",
    });
    assert.deepEqual(detached.observation, { kind: "detached" });
    const routed = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "routed",
      ...configured.placement,
      mode: "detach",
    });
    assert.deepEqual(routed.observation, { kind: "detached" });
    await assert.rejects(
      routedKeiyaku.call({
        path: world,
        archetype: "worker",
        body: "invalid",
        ...configured.placement,
        mode: "detach",
        timeoutMs: 1,
      }),
      /timeoutMs is not valid in detach mode/u,
    );
  } finally {
    await pump.close();
    leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("managed Contract calls use the appointed Place only when cwd is omitted", async () => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = await requestPump(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const managed = await Keiyaku.bind({
      repo,
      markdown: markdown("Implicit Contract cwd"),
      workspace: "worktree",
      hooks: { create: [], destroy: [] },
    });
    const managedId = (await managed.keiyaku.state()).id;
    const appointment = await readManagedWorktreeAppointment(git, managedId);
    assert.equal(appointment.kind, "appointed");
    if (appointment.kind !== "appointed") return;

    const invoked = await invoke(executable(["-C", ".", "call", "worker", "--contract", managedId, "-"]), {
      cwd: raw.path,
      environment: { ...process.env, KEIYAKU_HOME: configured.home },
      readStdin: async () => "implicit",
    });
    assert.equal("kind" in invoked && invoked.kind, "akuma");
    if (!("kind" in invoked) || invoked.kind !== "akuma" || invoked.action !== "call") return;
    const implicit = invoked.result;
    assert.deepEqual(implicit.execution, { cwd: appointment.path, source: "contract-worktree" });
    assert.equal((await readSoul(pathsForAkuId(world, implicit.akuma)))?.cwd, appointment.path);

    const nested = join(raw.path, "nested-invocation");
    const relative = join(nested, "relative-workdir");
    mkdirSync(relative, { recursive: true });
    const main = realpathSync(raw.path);
    const births = () => readdirSync(akumaRunRoot(world)).sort();
    const fromInvocation = await invoke(executable(["-C", "nested-invocation", "call", "worker", "-"]), {
      cwd: raw.path,
      environment: { ...process.env, KEIYAKU_HOME: configured.home },
      readStdin: async () => "from invocation",
    });
    assert.equal("kind" in fromInvocation && fromInvocation.kind, "akuma");
    if (!("kind" in fromInvocation) || fromInvocation.kind !== "akuma" || fromInvocation.action !== "call") return;
    assert.deepEqual(fromInvocation.result.execution, { cwd: realpathSync(nested), source: "input" });

    const fromRelativeWorkdir = await invoke(
      executable(["-C", "nested-invocation", "call", "worker", "--workdir", "relative-workdir", "-"]),
      {
        cwd: raw.path,
        environment: { ...process.env, KEIYAKU_HOME: configured.home },
        readStdin: async () => "relative workdir",
      },
    );
    assert.equal("kind" in fromRelativeWorkdir && fromRelativeWorkdir.kind, "akuma");
    if (!("kind" in fromRelativeWorkdir) || fromRelativeWorkdir.kind !== "akuma" || fromRelativeWorkdir.action !== "call") return;
    assert.deepEqual(fromRelativeWorkdir.result.execution, { cwd: realpathSync(relative), source: "input" });

    const wholeLoop = await invoke(
      executable(["-C", "nested-invocation", "call", "worker", "--contract", managedId, "--workdir", main, "-"]),
      {
        cwd: raw.path,
        environment: { ...process.env, KEIYAKU_HOME: configured.home },
        readStdin: async () => "whole loop in main",
      },
    );
    assert.equal("kind" in wholeLoop && wholeLoop.kind, "akuma");
    if (!("kind" in wholeLoop) || wholeLoop.kind !== "akuma" || wholeLoop.action !== "call") return;
    assert.deepEqual(wholeLoop.result.execution, { cwd: main, source: "input" });
    assert.equal((await readSoul(pathsForAkuId(world, wholeLoop.result.akuma)))?.cwd, main);

    const unavailableBefore = births();
    await assert.rejects(
      () =>
        invoke(executable(["call", "worker", "--workdir", "absent-workdir", "-"]), {
          cwd: raw.path,
          environment: { ...process.env, KEIYAKU_HOME: configured.home },
          readStdin: async () => "unavailable",
        }),
      /workdir is not an existing directory: absent-workdir/u,
    );
    assert.deepEqual(births(), unavailableBefore);

    const nonDirectory = join(nested, "not-a-directory");
    writeFileSync(nonDirectory, "not a directory\n");
    const nonDirectoryBefore = births();
    await assert.rejects(
      () =>
        invoke(executable(["-C", "nested-invocation", "call", "worker", "--workdir", "not-a-directory", "-"]), {
          cwd: raw.path,
          environment: { ...process.env, KEIYAKU_HOME: configured.home },
          readStdin: async () => "not a directory",
        }),
      /workdir is not an existing directory: not-a-directory/u,
    );
    assert.deepEqual(births(), nonDirectoryBefore);

    const missingValueBefore = births();
    assert.throws(() => executable(["call", "worker", "--workdir"]), /--workdir requires a path/u);
    assert.deepEqual(births(), missingValueBefore);

    const explicit = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "explicit",
      cwd: world,
      ...configured.placement,
      contract: managed.keiyaku,
    });
    assert.deepEqual(explicit.execution, { cwd: world, source: "input" });
    assert.equal((await readSoul(pathsForAkuId(world, explicit.akuma)))?.cwd, world);

    await managed.keiyaku.abandon({ hooks: { create: [], destroy: [] } });
  } finally {
    await pump.close();
    leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("direct Akuma birth reports process cwd and the embedding World fallback", async (t) => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  delete process.env[AKUMA_REQUESTS_ENV];
  const bodyPidReceipt = join(raw.path, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  const restoreSquareLedger = isolateSquareFixtureLedger(raw.path);
  let operationFailed = true;
  try {
    const akuma = Akuma.of(world, configured);
    const direct = await akuma.call({ archetype: "worker", body: "process" });
    assert.deepEqual(akumaCallExecution(direct), {
      cwd: realpathSync(process.cwd()),
      source: "process",
    });

    const fallback = await akuma.finishCall(await akuma.beginCall({ archetype: "worker", body: "world" }, {}));
    assert.deepEqual(akumaCallExecution(fallback), { cwd: world, source: "world" });
    assert.equal((await direct.wait(undefined, { timeoutMs: 2_000 })).life, "asleep");
    assert.equal((await fallback.wait(undefined, { timeoutMs: 2_000 })).life, "asleep");
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
      if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
      else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    }
  }
});

test("direct birth recipes freeze Archetype defaults and additive allowed values in every Soul", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  delete process.env[AKUMA_REQUESTS_ENV];
  try {
    const akuma = Akuma.of(world, configured);
    const omitted = await directBirthSoul(akuma, { archetype: "worker", body: "all" });
    assert.deepEqual(omitted.allowed, ALLOWED_ACTIONS);

    const restricted = await directBirthSoul(akuma, { archetype: "restricted", body: "default" });
    assert.deepEqual(restricted.allowed, ["task.add"]);
    assert.deepEqual((await PublicAkuma.select(world, restricted.id).status()).allowed, ["task.add"]);

    const added = await directBirthSoul(akuma, {
      archetype: "restricted",
      body: "add",
      allowed: ["akuma.call"],
    });
    assert.deepEqual(added.allowed, ["akuma.call", "task.add"]);

    const fullWithAddition = await directBirthSoul(akuma, {
      archetype: "worker",
      body: "full with addition",
      allowed: ["contract.deliver"],
    });
    assert.deepEqual(fullWithAddition.allowed, ALLOWED_ACTIONS);

    const emptyBase = await directBirthSoul(akuma, { archetype: "empty", body: "empty base" });
    assert.deepEqual(emptyBase.allowed, []);
    const emptyWithAddition = await directBirthSoul(akuma, {
      archetype: "empty",
      body: "empty with addition",
      allowed: ["akuma.call"],
    });
    assert.deepEqual(emptyWithAddition.allowed, ["akuma.call"]);

    writeFileSync(
      join(configured.home, "akuma", "restricted.md"),
      "---\nprovider: local\nallowed:\n  - contract.deliver\n---\nChanged.\n",
    );
    assert.deepEqual((await PublicAkuma.select(world, restricted.id).status()).allowed, ["task.add"]);

    writeFileSync(
      join(configured.home, "akuma", "reviewer.md"),
      "---\nprovider: local\nreadonly: true\n---\nReview.\n",
    );
    const callReadonly = await directBirthSoul(akuma, {
      archetype: "worker",
      body: "call readonly",
      readonly: true,
    });
    const markdownReadonly = await directBirthSoul(akuma, {
      archetype: "reviewer",
      body: "Markdown readonly",
    });
    assert.deepEqual(callReadonly.options, {
      readonly: true,
      systemPrompt: "Work.\n",
      systemPromptMode: "append",
    });
    assert.deepEqual(callReadonly.readonly, { enforcement: "native" });
    assert.deepEqual(markdownReadonly.options, {
      readonly: true,
      systemPrompt: "Review.\n",
      systemPromptMode: "append",
    });
    assert.deepEqual(markdownReadonly.readonly, { enforcement: "native" });

    for (const readonly of [false, "true"] as const) {
      await assert.rejects(
        akuma.call({ archetype: "worker", body: "invalid", readonly } as never),
        /Akuma call readonly must be true/u,
      );
      await assert.rejects(
        Keiyaku.call({
          path: world,
          archetype: "worker",
          body: "invalid",
          readonly,
          home: configured.home,
          settings: configured.value,
        } as never),
        /readonly must be true/u,
      );
    }
  } finally {
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("call-time allowed additions reject unknown and duplicate values", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  try {
    const akuma = Akuma.of(world, configured);
    await assert.rejects(
      akuma.call({ archetype: "worker", body: "invalid", allowed: ["akuma.unknown"] as never }),
      /Akuma call allowed contains an unknown action: akuma\.unknown/u,
    );
    await assert.rejects(
      akuma.call({ archetype: "worker", body: "invalid", allowed: ["akuma.call", "akuma.call"] }),
      /Akuma call allowed contains a duplicate action: akuma\.call/u,
    );
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Archetype allowed rejects unknown duplicate and non-string entries", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const akuma = Akuma.of(world, configured);
  const malformed = [
    ["unknown", "  - akuma.unknown\n", /unknown action: akuma\.unknown/u],
    ["duplicate", "  - akuma.call\n  - akuma.call\n", /duplicate action: akuma\.call/u],
    ["non-string", "  - 1\n", /unknown action: 1/u],
  ] as const;
  try {
    for (const [name, allowed, expected] of malformed) {
      writeFileSync(
        join(configured.home, "akuma", `${name}.md`),
        `---\nprovider: local\nallowed:\n${allowed}---\nWork.\n`,
      );
      await assert.rejects(Akuma.of(world, configured).call({ archetype: name, body: "invalid" }), expected);
    }
    assert.deepEqual((await akuma.list()).rows, []);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Archetype base inheritance resolves one frozen effective definition", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-base-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-base-home-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
    mkdirSync(join(home, "akuma"));
    writeFileSync(
      join(home, "akuma", "base.md"),
      [
        "---",
        "provider: codex-app-server",
        "model: base-model",
        "effort: high",
        "network: disabled",
        "description: Base description",
        "allowed:",
        "  - akuma.call",
        "readonly: true",
        "---",
        "Base body.",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, ".keiyaku", "akuma", "child.md"),
      ["---", "base: base", "model: child-model", "allowed: []", "---", ""].join("\n"),
    );
    const settingsValue = await settings({ root, home });
    const loaded = await loadArchetype({ name: "child", project: root, home, settings: settingsValue });
    assert.equal(loaded.provider.name, "codex-app-server");
    assert.deepEqual(loaded.options, {
      model: "child-model",
      effort: "high",
      network: "disabled",
      readonly: true,
      systemPrompt: "Base body.\n",
      systemPromptMode: "append",
    });
    assert.equal(loaded.description, "Base description");
    assert.deepEqual(loaded.allowed, []);
    assert.deepEqual(loaded.readonly, { enforcement: "native" });
    assert.deepEqual(await listArchetypeDefinitions({ project: root, home }), [
      { name: "base", model: "base-model", description: "Base description" },
      { name: "child", model: "child-model", description: "Base description" },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Archetype base lookup uses project precedence and Home fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-precedence-"));
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-precedence-home-"));
  try {
    mkdirSync(join(root, ".keiyaku", "akuma"), { recursive: true });
    mkdirSync(join(home, "akuma"));
    writeFileSync(join(home, "akuma", "base.md"), "---\nprovider: claude\ndescription: Home\n---\nHome body.\n");
    writeFileSync(
      join(root, ".keiyaku", "akuma", "base.md"),
      "---\nprovider: claude\ndescription: Project\n---\nProject body.\n",
    );
    writeFileSync(join(root, ".keiyaku", "akuma", "child.md"), "---\nbase: base\n---\n");
    writeFileSync(join(root, ".keiyaku", "akuma", "fallback.md"), "---\nbase: home-base\n---\n");
    writeFileSync(join(home, "akuma", "home-base.md"), "---\nprovider: claude\n---\nFallback body.\n");
    const settingsValue = await settings({ root, home });
    assert.equal(
      (await loadArchetype({ name: "child", project: root, home, settings: settingsValue })).description,
      "Project",
    );
    assert.equal(
      (await loadArchetype({ name: "fallback", project: root, home, settings: settingsValue })).path,
      join(root, ".keiyaku", "akuma", "fallback.md"),
    );
    assert.equal(
      (await loadArchetype({ name: "fallback", project: root, home, settings: settingsValue })).options.systemPrompt,
      "Fallback body.\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("Archetype inheritance freezes the resolved birth snapshot without base metadata", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  try {
    writeFileSync(
      join(configured.home, "akuma", "base.md"),
      "---\nprovider: local\nmodel: base\nallowed:\n  - task.add\nreadonly: true\n---\nBase body.\n",
    );
    writeFileSync(join(configured.home, "akuma", "child.md"), "---\nbase: base\nmodel: child\n---\nChild body.\n");
    const soul = await directBirthSoul(Akuma.of(world, configured), { archetype: "child", body: "run" });
    assert.equal(soul.provider.name, "local");
    assert.deepEqual(soul.options, {
      model: "child",
      readonly: true,
      systemPrompt: "Child body.\n",
      systemPromptMode: "append",
    });
    assert.deepEqual(soul.allowed, ["task.add"]);
    assert.deepEqual(soul.readonly, { enforcement: "native" });
    assert.equal("base" in soul, false);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Archetype base chains refuse missing providers, malformed names, and cycles", async () => {
  const home = mkdtempSync(join(tmpdir(), "keiyaku-akuma-archetype-invalid-base-"));
  try {
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
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

type MutableProvider = { -readonly [Key in keyof ProviderAdapter]: ProviderAdapter[Key] };

test("Keiyaku.fork propagates Dispatch and leaves Alias on the parent", async () => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Fork dispatch"), workspace: "worktree" });
  const owner = (await bound.keiyaku.state()).id;
  const source = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "face0001" });
  await initializeHeart(source.paths);
  await driveAkumaBody(
    {
      paths: source.paths,
      seed: {
        id: source.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        cwd: process.cwd(),
        origin: { kind: "direct" },
        allowed: ["akuma.call"],
      },
      initialBody: "work",
    },
    {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start() {
        return createProviderAttempt(undefined, async () => {
          let finishEvents!: () => void;
          const eventsFinished = new Promise<void>((resolve) => {
            finishEvents = resolve;
          });
          return {
            admission: { fence: "parent-session" },
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: "session" as const, coordinate: { sessionId: "parent-session" } };
                finishEvents();
              },
            },
            completion: eventsFinished.then(() => ({
              kind: "answered" as const,
              answer: "done",
              historyId: "history-1",
            })),
            async abort() {
              finishEvents();
            },
            async forceDispose() {
              finishEvents();
            },
          };
        });
      },
    },
    {
      now: () => "2026-08-11T01:00:00.000Z",
    },
  );
  await publishDispatch({ repository: git, akuId: source.id, contractId: owner });
  const alias = parseAkumaAlias("@parent");
  await moveAlias({ world, alias, akuId: source.id });

  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    mutable.fork = (input) => {
      assert.equal(input.at, "history-1");
      return createProviderAttempt(undefined, async () => ({ session: { sessionId: "child-session" } }));
    };
    const result = await Keiyaku.fork({ path: world, akuma: source.id, at: "turn/1", repo });
    assert.equal(result.kind, "forked", JSON.stringify(result));
    if (result.kind !== "forked") return;
    assert.equal(result.dispatch.kind, "dispatched");
    assert.equal((await readDispatch(git, result.child))?.contractId, owner);
    assert.equal(await resolveAlias(world, alias), source.id);
    assert.deepEqual((await readSoul(pathsForAkuId(world, result.child)))?.allowed, ["akuma.call"]);

    const snapshot = await readGit(git);
    const dispatchPath = `dispatch/${createHash("sha256").update(source.id).digest("hex")}.json`;
    const blob = await writeBlob(git, Buffer.from("broken\n"));
    const tree = await updateGitTree(git, snapshot.tree, new Map([[dispatchPath, { oid: blob }]]));
    const commit = await writeCommit({
      repository: git,
      tree,
      parent: snapshot.commit,
      message: "corrupt parent dispatch",
      at: "2026-08-11T01:00:01.000Z",
    });
    assert.equal(
      (await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind,
      "published",
    );
    const partial = await Keiyaku.fork({ path: world, akuma: source.id, at: "turn/1", repo });
    assert.equal(partial.kind, "forked", JSON.stringify(partial));
    if (partial.kind !== "forked") return;
    assert.equal(partial.dispatch.kind, "failed");
    if (partial.dispatch.kind !== "failed") return;
    assert.equal(partial.dispatch.failure.kind, "authority-corruption");
  } finally {
    if (originalFork === undefined) delete mutable.fork;
    else mutable.fork = originalFork;
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Keiyaku.call carries the CallResult restraint on detached and failed observations", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const home = join(raw.path, ".test-settings");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "grok-review.md"), "---\nprovider: grok-build\nreadonly: true\n---\n");
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(home, "akuma", "reviewer.md"), "---\nprovider: claude\nreadonly: true\n---\nReview only.\n");
  const configured = await settings({ root: world, home });
  const placement = { home, settings: configured };
  const { pump, leash } = await requestPump(world);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  const originalWait = AkumaHandle.prototype.wait;
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const detached = await routedKeiyaku.call({
      path: world,
      archetype: "grok-review",
      body: "",
      ...placement,
      mode: "detach",
    });
    assert.deepEqual(detached.readonly, {
      enforcement: "none",
      diagnostic: "Grok Build cannot remove task-surface mutation capabilities",
    });
    assert.deepEqual(detached.observation, { kind: "detached" });

    const observed = await routedKeiyaku.call({ path: world, archetype: "reviewer", body: "observed", ...placement });
    assert.equal(observed.observation.kind, "observed");
    if (observed.observation.kind === "observed")
      assert.deepEqual(observed.observation.status.readonly, observed.readonly);
    assert.deepEqual((await readSoul(pathsForAkuId(world, observed.akuma)))?.readonly, observed.readonly);

    AkumaHandle.prototype.wait = async function () {
      throw new Error("heart unavailable");
    };
    const failed = await routedKeiyaku.call({
      path: world,
      archetype: "reviewer",
      body: "fail",
      ...placement,
    });
    assert.deepEqual(failed.readonly, { enforcement: "native" });
    assert.equal(failed.observation.kind, "failed");
  } finally {
    AkumaHandle.prototype.wait = originalWait;
    await pump.close();
    leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
  }
});
