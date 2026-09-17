import { temporaryDirectory } from "./support/process.js";
import { deferred as promiseBarrier } from "./support/process.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { AkumaArchetypeError, loadArchetype } from "../src/akuma/archetype.js";
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
  const { promise: started, resolve: resolveStarted } = promiseBarrier<Readonly<{ paths: AkumaCallRequestChildLaunch["paths"]; bodySequence: number }>>();
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
    assert.ok(associated.dispatch.kind === "dispatched", "expected associated.dispatch.kind = \"dispatched\"");
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
    assert.ok(appointment.kind === "appointed", "expected appointment.kind = \"appointed\"");

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
          const { promise: eventsFinished, resolve: finishEvents } = promiseBarrier<void>();
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
    assert.ok(result.kind === "forked", JSON.stringify(result));
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
    assert.ok(partial.kind === "forked", JSON.stringify(partial));
    assert.ok(partial.dispatch.kind === "failed", "expected partial.dispatch.kind = \"failed\"");
    assert.equal(partial.dispatch.failure.kind, "authority-corruption");
  } finally {
    if (originalFork === undefined) delete mutable.fork;
    else mutable.fork = originalFork;
    rmSync(raw.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
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
