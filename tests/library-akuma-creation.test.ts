import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { moveAlias, resolveAlias } from "../src/alias/index.js";
import { AkumaHandle } from "../src/akuma/akuma.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart, readSoul, type Soul } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, pathsForAkuId } from "../src/akuma/identity.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import type { ProviderAdapter } from "../src/akuma/provider.js";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { BodyRequestPump } from "../src/akuma/requests.js";
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
import { Keiyaku, Repo, World, settings } from "../src/index.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";

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

async function repositoryFixture() {
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
  raw.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
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

async function requestPump(root: string) {
  const parent = await allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  await initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: {},
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "unconfined" },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const leash = (await HeldAkumaLeash.try(parent.paths))!;
  await leash.birth(parent.paths, soul);
  const pump = await BodyRequestPump.open({
    paths: parent.paths,
    parent: soul,
    bodySequence: 1,
    now: () => "2026-08-11T00:00:01.000Z",
    signal: new AbortController().signal,
    async spawn(launch) {
      const child = (await HeldAkumaLeash.try(launch.paths))!;
      await child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-11T00:00:02.000Z" });
      child.release();
    },
  });
  return { pump, leash };
}

test("Keiyaku.call keeps optional Dispatch and Alias stages honest", async () => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = await requestPump(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const independent = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "independent",
      ...configured.placement,
    });
    assert.deepEqual(independent.dispatch, { kind: "none" });
    assert.deepEqual(independent.alias, { kind: "none" });
    assert.deepEqual(independent.execution, { cwd: world, source: "world" });
    assert.equal(independent.observation.kind, "observed");
    assert.equal(await readDispatch(git, independent.akuma), null);

    const bound = await Keiyaku.bind({ repo, markdown: markdown("Akuma dispatch"), workspace: "here" });
    const owner = (await bound.keiyaku.state()).id;
    const alias = parseAkumaAlias("@worker");
    const executionCwd = join(raw.path, "nested-worktree");
    mkdirSync(executionCwd);
    const invoked = await invoke(parseArgv([
      "-C",
      executionCwd,
      "call",
      "worker",
      "--repo",
      "..",
      "--contract",
      owner,
      "--alias",
      alias,
      "-",
    ]), {
      environment: { ...process.env, KEIYAKU_HOME: configured.home },
      readStdin: () => "associated",
    });
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
    assert.equal(
      (await readSoul(pathsForAkuId(world, associated.akuma)))?.cwd,
      realpathSync(executionCwd),
    );

    writeFileSync(join(raw.path, ".keiyaku", "akuma", "alias.json"), "broken\n");
    const partial = await Keiyaku.call({
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

    const detached = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "detached",
      ...configured.placement,
      mode: "detach",
    });
    assert.deepEqual(detached.observation, { kind: "detached" });
    await assert.rejects(
      Keiyaku.call({
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

    const invoked = await invoke(parseArgv([
      "call",
      "worker",
      "--contract",
      managedId,
      "-",
    ]), {
      cwd: raw.path,
      environment: { ...process.env, KEIYAKU_HOME: configured.home },
      readStdin: () => "implicit",
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

    const here = await Keiyaku.bind({
      repo,
      markdown: markdown("Here Contract"),
      workspace: "here",
    });
    await assert.rejects(
      Keiyaku.call({
        path: world,
        archetype: "worker",
        body: "must refuse",
        ...configured.placement,
        contract: here.keiyaku,
      }),
      /Contract workspace is unavailable: .* is here/u,
    );
    await here.keiyaku.abandon();
  } finally {
    await pump.close();
    leash.release();
    if (previousRequests === undefined) delete process.env[AKUMA_REQUESTS_ENV];
    else process.env[AKUMA_REQUESTS_ENV] = previousRequests;
    rmSync(raw.path, { recursive: true, force: true });
  }
});

test("Keiyaku.call projects the same readonly restraint on CallResult and AkumaStatus", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = await requestPump(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const result = await Keiyaku.call({
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
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  const originalWait = AkumaHandle.prototype.wait;
  let receivedTimeout: number | undefined;
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  AkumaHandle.prototype.wait = async function (predicate, options) {
    receivedTimeout = options?.timeoutMs;
    return await originalWait.call(this, predicate, { timeoutMs: 0 });
  };
  try {
    const result = await Keiyaku.call({
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
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Fork dispatch"), workspace: "here" });
  const owner = (await bound.keiyaku.state()).id;
  const source = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "face0001" });
  await initializeHeart(source.paths);
  await driveAkumaBody({
    paths: source.paths,
    seed: {
      id: source.id,
      archetype: "claude",
      provider: { name: "claude", kind: "claude-agent-sdk" },
      options: {},
      cwd: process.cwd(),
      origin: { kind: "direct" },
      confinement: { kind: "unconfined" },
    },
    initialBody: "work",
  }, {
    confinement: () => ({ kind: "unconfined" }),
    admitOptions(options) { return { kind: "admitted", options }; },
    async start() {
      let finishEvents!: () => void;
      const eventsFinished = new Promise<void>((resolve) => { finishEvents = resolve; });
      return {
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
        async abort() {},
      };
    },
  }, {
    now: () => "2026-08-11T01:00:00.000Z",
  });
  await publishDispatch({ repository: git, akuId: source.id, contractId: owner });
  const alias = parseAkumaAlias("@parent");
  await moveAlias({ world, alias, akuId: source.id });

  const mutable = claudeProvider as MutableProvider;
  const originalFork = mutable.fork;
  try {
    mutable.fork = async () => ({ session: { sessionId: "child-session" } });
    const result = await Keiyaku.fork({ path: world, akuma: source.id, at: "history-1", repo });
    assert.equal(result.kind, "forked", JSON.stringify(result));
    if (result.kind !== "forked") return;
    assert.equal(result.dispatch.kind, "dispatched");
    assert.equal((await readDispatch(git, result.child))?.contractId, owner);
    assert.equal(await resolveAlias(world, alias), source.id);

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
    assert.equal((await updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }])).kind, "published");
    const partial = await Keiyaku.fork({ path: world, akuma: source.id, at: "history-1", repo });
    assert.equal(partial.kind, "forked", JSON.stringify(partial));
    if (partial.kind !== "forked") return;
    assert.equal(partial.dispatch.kind, "failed");
    if (partial.dispatch.kind !== "failed") return;
    assert.equal(partial.dispatch.failure.kind, "authority-corruption");
  } finally {
    mutable.fork = originalFork;
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
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  const originalWait = AkumaHandle.prototype.wait;
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const detached = await Keiyaku.call({
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
    const failed = await Keiyaku.call({
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
