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
  return { raw, repo: Repo.at({ path: raw.path }), git: repositoryAt(raw.path) };
}

async function archetypeSettings(root: string) {
  const home = join(root, ".test-settings");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  return { home, value: await settings({ root, home }) };
}

function requestPump(root: string) {
  const parent = allocateAkumaDirectory({ worldRoot: root, archetype: "parent", draw: () => "1234abcd" });
  initializeHeart(parent.paths);
  const soul: Soul = {
    id: parent.id,
    archetype: "parent",
    provider: { name: "codex-app-server", kind: "codex-app-server" },
    options: { access: "write" },
    cwd: root,
    origin: { kind: "direct" },
    confinement: { kind: "unconfined" },
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const leash = HeldAkumaLeash.try(parent.paths)!;
  leash.birth(parent.paths, soul);
  const pump = new BodyRequestPump({
    paths: parent.paths,
    parent: soul,
    bodySequence: 1,
    now: () => "2026-08-11T00:00:01.000Z",
    signal: new AbortController().signal,
    async spawn(launch) {
      const child = HeldAkumaLeash.try(launch.paths)!;
      child.birth(launch.paths, { ...launch.seed, createdAt: "2026-08-11T00:00:02.000Z" });
      child.release();
    },
  });
  return { pump, leash };
}

test("Keiyaku.call keeps optional Dispatch and Alias stages honest", async () => {
  const { raw, repo, git } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = requestPump(world);
  const previousRequests = process.env[AKUMA_REQUESTS_ENV];
  process.env[AKUMA_REQUESTS_ENV] = pump.directory;
  try {
    const independent = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "independent",
      settings: configured.value,
    });
    assert.deepEqual(independent.dispatch, { kind: "none" });
    assert.deepEqual(independent.alias, { kind: "none" });
    assert.equal(independent.observation.kind, "observed");
    assert.equal(readDispatch(git, independent.akuma), null);

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
    assert.deepEqual(readDispatch(git, associated.akuma), associated.dispatch.dispatch);
    assert.deepEqual(associated.alias, {
      kind: "aliased",
      alias: { alias, akuId: associated.akuma },
      previous: null,
    });
    assert.equal(associated.observation.kind, "observed");
    assert.equal(
      readSoul(pathsForAkuId(world, associated.akuma))?.cwd,
      realpathSync(executionCwd),
    );

    writeFileSync(join(raw.path, ".keiyaku", "akuma", "alias.json"), "broken\n");
    const partial = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "partial",
      settings: configured.value,
      contract: bound.keiyaku,
      alias,
    });
    assert.equal(partial.dispatch.kind, "dispatched");
    assert.equal(partial.alias.kind, "failed");
    assert.equal(partial.observation.kind, "observed");
    assert.notEqual(readDispatch(git, partial.akuma), null);

    const detached = await Keiyaku.call({
      path: world,
      archetype: "worker",
      body: "detached",
      settings: configured.value,
      mode: "detach",
    });
    assert.deepEqual(detached.observation, { kind: "detached" });
    await assert.rejects(
      Keiyaku.call({
        path: world,
        archetype: "worker",
        body: "invalid",
        settings: configured.value,
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

test("Keiyaku.call observes for five minutes by default", async () => {
  const { raw } = await repositoryFixture();
  const world = await World.at(raw.path);
  const configured = await archetypeSettings(world);
  const { pump, leash } = requestPump(world);
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
      settings: configured.value,
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
  const source = allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "face0001" });
  initializeHeart(source.paths);
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
      return {
        events: { async *[Symbol.asyncIterator]() { yield { type: "session" as const, coordinate: { sessionId: "parent-session" } }; } },
        completion: Promise.resolve({ kind: "answered", answer: "done", historyId: "history-1" }),
        async abort() {},
      };
    },
  }, {
    now: () => "2026-08-11T01:00:00.000Z",
  });
  publishDispatch({ repository: git, akuId: source.id, contractId: owner });
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
    assert.equal(readDispatch(git, result.child)?.contractId, owner);
    assert.equal(resolveAlias(world, alias), source.id);

    const snapshot = readGit(git);
    const dispatchPath = `dispatch/${createHash("sha256").update(source.id).digest("hex")}.json`;
    const blob = writeBlob(git, Buffer.from("broken\n"));
    const tree = updateGitTree(git, snapshot.tree, new Map([[dispatchPath, { oid: blob }]]));
    const commit = writeCommit({
      repository: git,
      tree,
      parent: snapshot.commit,
      message: "corrupt parent dispatch",
      at: "2026-08-11T01:00:01.000Z",
    });
    assert.equal(updateRefsAtomically(git, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]).kind, "published");
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
