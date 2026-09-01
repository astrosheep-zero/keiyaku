import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { moveAlias, resolveAlias } from "../src/alias/index.js";
import { Akuma, AkumaHandle, akumaCallExecution, type AkumaCallInput } from "../src/akuma/akuma.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { akumaCallRequestCommands } from "../src/akuma/call-request.js";
import { AkumaArchetypeError, listArchetypeDefinitions, loadArchetype } from "../src/akuma/archetype.js";
import { HeldAkumaLeash, initializeHeart, readSoul, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { AKUMA_REQUESTS_ENV, createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/request-serve.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
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
import { invoke } from "../src/cli/invoke.js";
import { parseArgv, type ParsedExecution } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";
import type { WorldRoot } from "../src/world.js";

function markdown(title: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "context",
    "",
    "## Objective",
    "objective",
    "",
    "## Design",
    "design",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### C1",
    "criterion",
    "",
  ].join("\n");
}

function executable(argv: readonly string[]): ParsedExecution {
  const parsed = parseArgv(argv);
  if (!("command" in parsed)) throw new Error("expected executable command");
  return parsed;
}

async function repositoryFixture() {
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
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
      "  send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
      "});",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return { home, value: await settings({ root, home }) };
}

async function directBirthSoul(akuma: Akuma, input: AkumaCallInput): Promise<Soul> {
  const born = await akuma.beginCall(input, { initiatorCwd: process.cwd() });
  assert.equal(born.kind, "born");
  if (born.kind !== "born") throw new Error("direct call unexpectedly entered the Body Request path");
  await driveAkumaBody({ paths: born.allocated.paths, seed: born.seed });
  const soul = await readSoul(born.allocated.paths);
  assert.notEqual(soul, null);
  return soul!;
}

async function requestPump(root: WorldRoot) {
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
    commands: akumaCallRequestCommands({
      world: root,
      paths: parent.paths,
      parent: soul,
      spawn: async (launch) => {
        const child = (await HeldAkumaLeash.try(launch.paths))!;
        await child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-11T00:00:02.000Z" });
        child.release();
      },
    }),
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

test("Keiyaku.call dispatches the admitted generic signal without blocking completion", async () => {
  const { raw, repo } = await repositoryFixture();
  const world = await World.at(raw.path);
  const trace = join(raw.path, "called.json");
  const ready = join(raw.path, "called.ready");
  mkdirSync(join(raw.path, ".keiyaku"), { recursive: true });
  mkdirSync(join(raw.path, "plugins"), { recursive: true });
  writeFileSync(
    join(raw.path, "plugins", "called.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      "export default {",
      '  manifest: { id: "called", apiVersion: 1 },',
      '  activate(context) { writeFileSync(context.config.ready, "ready"); return { signals: { "akuma.called": (signal) => writeFileSync(context.config.trace, JSON.stringify(signal)) } }; },',
      "};",
    ].join("\n"),
  );
  writeFileSync(
    join(raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({ plugins: { called: { package: "./plugins/called.mjs", config: { trace, ready } } } }),
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
    const result = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "called",
      ...configured.placement,
      contract: bound.keiyaku,
      cwd: raw.path,
      mode: "detach",
    });
    const deadline = Date.now() + 1_000;
    while (!existsSync(trace)) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for called plugin signal");
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
      kind: "akuma.called",
      akumaId: result.akuma,
      callerAkumaId: "aku/parent/1234abcd",
      contractId,
    });
  } finally {
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
      executable(["-C", executionCwd, "call", "worker", "--repo", "..", "--contract", owner, "--alias", alias, "-"]),
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

    const invoked = await invoke(executable(["call", "worker", "--contract", managedId, "-"]), {
      cwd: raw.path,
      environment: { ...process.env, KEIYAKU_HOME: configured.home },
      readStdin: async () => "implicit",
    });
    assert.equal("kind" in invoked && invoked.kind, "akuma");
    if (!("kind" in invoked) || invoked.kind !== "akuma" || invoked.action !== "call") return;
    const implicit = invoked.result;
    assert.deepEqual(implicit.execution, { cwd: appointment.path, source: "contract-worktree" });
    assert.equal((await readSoul(pathsForAkuId(world, implicit.akuma)))?.cwd, appointment.path);

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

test("direct Akuma birth reports process cwd and the embedding World fallback", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await directArchetypeSettings(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  delete process.env[AKUMA_REQUESTS_ENV];
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
  } finally {
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
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
    writeFileSync(join(root, ".keiyaku", "akuma", "base.md"), "---\nprovider: claude\ndescription: Project\n---\nProject body.\n");
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
    writeFileSync(
      join(configured.home, "akuma", "child.md"),
      "---\nbase: base\nmodel: child\n---\nChild body.\n",
    );
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

test("Keiyaku.call projects the same readonly restraint on CallResult and AkumaStatus", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = await requestPump(world);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const result = await routedKeiyaku.call({
      path: world,
      archetype: "reviewer",
      body: "review",
      ...configured.placement,
    });
    assert.deepEqual(result.readonly, { enforcement: "native" });
    assert.equal(result.observation.kind, "observed");
    if (result.observation.kind === "observed") {
      assert.deepEqual(result.observation.status.readonly, result.readonly);
    }
    assert.deepEqual((await readSoul(pathsForAkuId(world, result.akuma)))?.readonly, result.readonly);
  } finally {
    await pump.close();
    leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Keiyaku.call observes for five minutes by default", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = await requestPump(world);
  const routedKeiyaku = Keiyaku.withExecution({ execution: bodyRequestExecution({ directory: pump.directory }) });
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  const originalWait = AkumaHandle.prototype.wait;
  let receivedTimeout: number | undefined;
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  AkumaHandle.prototype.wait = async function (predicate, options) {
    receivedTimeout = options?.timeoutMs;
    return await originalWait.call(this, predicate, { timeoutMs: 0 });
  };
  try {
    const result = await routedKeiyaku.call({
      path: world,
      archetype: "worker",
      body: "observe",
      ...configured.placement,
    });
    assert.equal(receivedTimeout, 300_000);
    assert.equal(result.observation.kind, "observed");
  } finally {
    AkumaHandle.prototype.wait = originalWait;
    await pump.close();
    leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
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
