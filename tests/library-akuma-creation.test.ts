import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { AkumaArchetypeError, loadArchetype } from "../src/akuma/archetype.js";
import { akumaCallRequestCommands, type AkumaCallRequestChildLaunch } from "../src/akuma/call-request.js";
import { fleetRequestCommands, type FleetRequestPort } from "../src/akuma/fleet-request.js";
import { HeldAkumaLeash, initializeHeart, readHeart, readSoul, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, parseAkuId, pathsForAkuId } from "../src/akuma/identity.js";
import { Akuma as PublicAkuma, Schema } from "../src/akuma/index.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { composeRequestCommands } from "../src/akuma/request-wire.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv, type ParsedExecution } from "../src/cli/parse.js";
import { readDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { bodyRequestExecution, Keiyaku, Repo, settings, World } from "../src/index.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import type { WorldRoot } from "../src/world.js";
import { AkumaHandle, isolateSquareFixtureLedger } from "./support/akuma-composition.js";
import { makeGitRepository } from "./support/git.js";
import { contractMarkdown } from "./support/markdown.js";
import {
  cleanupSpawnCapableFixture,
  installAkumaBodyEmptyPublicationBarrier,
  installAkumaBodyPidReceipt,
  temporaryDirectory,
  waitForFixtureFile,
} from "./support/process.js";

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

test("Keiyaku.call preserves dispatch, alias failure, and managed versus explicit cwd", async () => {
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
    const appointment = await readManagedWorktreeAppointment(git, owner);
    assert.ok(appointment.kind === "appointed", 'expected appointment.kind = "appointed"');
    const alias = parseAkumaAlias("@worker");
    const executionCwd = join(raw.path, "nested-worktree");
    mkdirSync(executionCwd);
    const invoked = await invoke(
      executable(["-C", executionCwd, "call", "worker", "--repo", "..", "--contract", owner, "--alias", alias, "-"]),
      {
        environment: { ...process.env, KEIYAKU_HOME: configured.home },
        readStdin: async () => "associated",
      },
    );
    assert.ok("kind" in invoked && invoked.kind === "akuma" && invoked.action === "call");
    const associated = invoked.result;
    assert.ok(associated.dispatch.kind === "dispatched", 'expected associated.dispatch.kind = "dispatched"');
    assert.equal(associated.dispatch.dispatch.contractId, owner);
    assert.deepEqual(await readDispatch(git, associated.akuma), associated.dispatch.dispatch);
    assert.deepEqual(associated.alias, {
      kind: "aliased",
      alias: { alias, akuId: associated.akuma },
      previous: null,
    });
    assert.equal(associated.observation.kind, "observed");
    assert.deepEqual(associated.execution, { cwd: appointment.path, source: "contract-worktree" });
    assert.equal((await readSoul(pathsForAkuId(world, associated.akuma)))?.cwd, appointment.path);

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
    assert.deepEqual(partial.execution, { cwd: realpathSync(executionCwd), source: "input" });
    assert.equal((await readSoul(pathsForAkuId(world, partial.akuma)))?.cwd, realpathSync(executionCwd));

    const detached = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "detached",
      ...configured.placement,
      mode: "detach",
    });
    assert.deepEqual(detached.observation, { kind: "detached" });
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
