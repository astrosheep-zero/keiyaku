import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { moveAlias, readAliases, tryAcquireAliasCustody } from "../src/alias/index.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart, recordTell } from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, type AllocatedAkuma } from "../src/akuma/identity.js";
import { readRetentionCandidate, retireInactiveAkuma } from "../src/akuma/retention.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { readGitPaths, repositoryAt } from "../src/git/repository.js";
import { isPrivateStateSeatContention, withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { settings } from "../src/index.js";
import { sweepInactiveAkumas } from "../src/library/akuma-retention.js";
import { Akumas } from "../src/library/akumas.js";
import { World, type WorldRoot } from "../src/world.js";
import { answering } from "./support/akuma-tell.js";
import { appointedWorktreePath, cachedRepositoryAt, makeGitRepository } from "./support/git.js";
import { accepted, bind, present } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const OLD = "2020-01-01T00:00:00.000Z";

function worldAt(context: TestContext, prefix: string): Promise<WorldRoot> {
  return World.at(temporaryDirectory(context, prefix));
}

/** Age the durable custody metadata so the cheap prefilter can see an old Heart. */
function ageAkuma(allocated: AllocatedAkuma, at: string): void {
  const date = new Date(at);
  for (const path of [allocated.paths.heart, `${allocated.paths.heart}-wal`]) {
    if (existsSync(path)) utimesSync(path, date, date);
  }
}

async function oldAkuma(world: WorldRoot, suffix: string, at = OLD): Promise<AllocatedAkuma> {
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveAkumaBody(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        archetype: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        allowed: [],
        cwd: world,
      },
      initialBody: "old work",
    },
    answering("done"),
    { now: () => at },
  );
  ageAkuma(allocated, at);
  return allocated;
}

async function runningAkuma(
  world: WorldRoot,
  suffix: string,
): Promise<Readonly<{ allocated: AllocatedAkuma; leash: HeldAkumaLeash }>> {
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    origin: { kind: "direct" },
    allowed: [],
    cwd: world,
    createdAt: OLD,
  });
  await leash.recordBody(allocated.paths, { leashTakenAt: OLD });
  ageAkuma(allocated, OLD);
  return { allocated, leash };
}

function repositoryFixture() {
  const raw = makeGitRepository();
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return raw;
}

/** One callable worker whose fake provider answers its first Turn immediately. */
async function callSettings(root: string) {
  const home = join(root, ".call-settings");
  const executable = join(root, "fake-codex");
  symlinkSync(join(process.cwd(), "node_modules"), join(root, "node_modules"), "dir");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: local\n---\nWork.\n");
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ providers: { local: { kind: "codex-app-server", executable } } }),
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
  return { home, value: await settings({ root, home }) };
}

async function boundContract(raw: ReturnType<typeof makeGitRepository>, verification?: string) {
  return await bind(raw, verification);
}

async function claimedContract(raw: ReturnType<typeof makeGitRepository>) {
  const keiyaku = await boundContract(raw, "exit 0");
  const state = present(await keiyaku.state());
  const worktree = await appointedWorktreePath(await cachedRepositoryAt(raw.path), state.id);
  writeFileSync(join(worktree, "candidate.txt"), "candidate\n");
  raw.run(["-C", worktree, "add", "candidate.txt"]);
  raw.run(["-C", worktree, "commit", "--quiet", "-m", "candidate"]);
  accepted(await keiyaku.deliver());
  assert.equal(present(await keiyaku.state()).terminal?.kind, "claimed");
  return state.id;
}

test("a successful call runs the maintenance pass while read-only observations never retire", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const settingsFixture = await callSettings(raw.path);
  const old = await oldAkuma(world, "a0000001");
  const recent = await oldAkuma(world, "a0000002", new Date().toISOString());

  const listed = await Akumas.of(world).list();
  assert.ok(listed.rows.some((row) => row.id === old.id));
  await Akumas.of(world).status({ akuma: old.id });
  await Akumas.of(world).history({ akuma: old.id });
  await Akumas.of(world).wait({ akuma: [old.id] });
  assert.equal(existsSync(old.paths.heart), true, "read-only observations must not retire");

  const called = await Akumas.of(world).call({
    archetype: "worker",
    body: "ping",
    mode: "wait",
    timeoutMs: 15_000,
    home: settingsFixture.home,
    settings: settingsFixture.value,
  });
  assert.equal(called.kind, "called");
  assert.equal(existsSync(old.paths.directory), false);
  assert.equal(existsSync(recent.paths.heart), true);
  assert.deepEqual(await sweepInactiveAkumas(world), [], "removal is idempotent and the recent entry survives");
  assert.equal(existsSync(recent.paths.heart), true);
});

test("a same-handle later call reruns maintenance after a sweep failure", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const settingsFixture = await callSettings(raw.path);
  const akumas = Akumas.of(world);
  const first = await oldAkuma(world, "a0000003");
  const aliasAuthority = join(world, ".keiyaku", "akuma", "alias.json");
  writeFileSync(aliasAuthority, "not json\n");

  const one = await akumas.call({
    archetype: "worker",
    body: "ping",
    mode: "wait",
    timeoutMs: 15_000,
    home: settingsFixture.home,
    settings: settingsFixture.value,
  });
  assert.equal(one.kind, "called");
  assert.equal(existsSync(first.paths.heart), true, "a failed sweep is retried by a later call");

  unlinkSync(aliasAuthority);
  const second = await oldAkuma(world, "a0000004");
  const two = await akumas.call({
    archetype: "worker",
    body: "ping",
    mode: "wait",
    timeoutMs: 15_000,
    home: settingsFixture.home,
    settings: settingsFixture.value,
  });
  assert.equal(two.kind, "called");
  assert.equal(existsSync(first.paths.heart), false);
  assert.equal(existsSync(second.paths.heart), false);
});

test("the strict cutoff retains an Akuma exactly fifteen days old and retires one millisecond older", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-cutoff-");
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const exact = await oldAkuma(world, "b0000001", new Date(now - 15 * DAY_MS).toISOString());
  const older = await oldAkuma(world, "b0000002", new Date(now - 15 * DAY_MS - 1).toISOString());
  // Both metadata bounds pass the cheap prefilter; only semantic Heart age decides.
  ageAkuma(exact, OLD);
  ageAkuma(older, OLD);

  assert.deepEqual(await sweepInactiveAkumas(world, { now }), [older.id]);
  assert.equal(existsSync(exact.paths.heart), true);
  assert.equal(existsSync(older.paths.directory), false);
});

test("a running old Akuma, an aliased Akuma, and pending input survive", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-retained-");
  const running = await runningAkuma(world, "c0000001");
  const aliased = await oldAkuma(world, "c0000002");
  const pending = await oldAkuma(world, "c0000003");
  await moveAlias({ world, alias: parseAkumaAlias("@kept"), akuId: aliased.id });
  // A pending Tell is durable input that a later wake must still recover.
  assert.equal(
    (await recordTell(pending.paths, { kind: "tell", id: "pending-tell", body: "still recoverable", recordedAt: OLD }))
      .kind,
    "recorded",
  );
  ageAkuma(pending, OLD);

  assert.deepEqual(await sweepInactiveAkumas(world), []);
  assert.equal(existsSync(running.allocated.paths.heart), true);
  assert.equal(existsSync(aliased.paths.heart), true);
  assert.equal(existsSync(pending.paths.heart), true);
  assert.deepEqual(
    (await readAliases(world)).map((binding) => binding.alias),
    [parseAkumaAlias("@kept")],
  );
  running.leash.release();
});

test("Dispatch associations keep active, missing, and unproven Contracts while terminal ones retire", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const repository = await repositoryAt(raw.path);

  const active = await oldAkuma(world, "d0000001");
  const abandoned = await oldAkuma(world, "d0000002");
  const claimed = await oldAkuma(world, "d0000003");
  const missing = await oldAkuma(world, "d0000004");

  const activeContract = await boundContract(raw);
  const abandonedContract = await boundContract(raw);
  const activeId = present(await activeContract.state()).id;
  const abandonedId = present(await abandonedContract.state()).id;
  accepted(await abandonedContract.abandon());

  const claimedId = await claimedContract(raw);
  assert.equal((await publishDispatch({ repository, akuId: active.id, contractId: activeId })).kind, "dispatched");
  assert.equal(
    (await publishDispatch({ repository, akuId: abandoned.id, contractId: abandonedId })).kind,
    "dispatched",
  );
  assert.equal((await publishDispatch({ repository, akuId: claimed.id, contractId: claimedId })).kind, "dispatched");
  assert.equal(
    (await publishDispatch({ repository, akuId: missing.id, contractId: contractId("kei/never-bound") })).kind,
    "dispatched",
  );

  assert.deepEqual(await sweepInactiveAkumas(world), [abandoned.id, claimed.id]);
  assert.equal(existsSync(active.paths.heart), true);
  assert.equal(existsSync(missing.paths.heart), true);
  assert.equal(existsSync(abandoned.paths.directory), false);
  assert.equal(existsSync(claimed.paths.directory), false);
});

test("a failed Dispatch observation keeps the candidate", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const repository = await repositoryAt(raw.path);
  const allocated = await oldAkuma(world, "d0000005");
  assert.equal(
    (await publishDispatch({ repository, akuId: allocated.id, contractId: contractId("kei/unavailable-owner") })).kind,
    "dispatched",
  );
  const path = `dispatch/${createHash("sha256").update(allocated.id).digest("hex")}.json`;
  const entry = (await readGitPaths(repository, [path])).paths.get(path);
  assert.equal(entry?.type, "blob");
  if (entry?.type !== "blob") throw new Error("fixture Dispatch is not a blob");
  unlinkSync(join(repository.commonDirectory, "objects", entry.oid.slice(0, 2), entry.oid.slice(2)));

  assert.deepEqual(await sweepInactiveAkumas(world), []);
  assert.equal(existsSync(allocated.paths.heart), true);
});

test("removal holds Alias custody across the effect so a concurrent move cannot interleave", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-custody-");
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const allocated = await oldAkuma(world, "e0000001", new Date(now - 20 * DAY_MS).toISOString());
  const candidate = await readRetentionCandidate({ id: allocated.id, paths: allocated.paths }, now);
  assert.ok(candidate !== null);

  let moving: Promise<unknown> | undefined;
  const receipt = await retireInactiveAkuma({
    entry: candidate,
    now,
    retireUnderCustody: async (retire) => {
      assert.equal(await HeldAkumaLeash.try(allocated.paths), null, "retention must hold the execution seat");
      const custody = await tryAcquireAliasCustody(world);
      assert.ok(custody !== null);
      try {
        moving = moveAlias({ world, alias: parseAkumaAlias("@raced"), akuId: allocated.id });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.deepEqual(await readAliases(world), [], "a concurrent Alias move cannot commit before removal");
        assert.equal(await retire(), true);
        return "retired";
      } finally {
        custody.release();
      }
    },
  });
  assert.equal(receipt, "retired");
  assert.equal(existsSync(allocated.paths.heart), false);
  await moving;
  assert.deepEqual(
    (await readAliases(world)).map((binding) => binding.alias),
    [parseAkumaAlias("@raced")],
  );
});

test("a pending Tell observed by the final read prevents removal", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-late-tell-");
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const allocated = await oldAkuma(world, "e0000004", new Date(now - 20 * DAY_MS).toISOString());
  const candidate = await readRetentionCandidate({ id: allocated.id, paths: allocated.paths }, now);
  assert.ok(candidate !== null);

  const receipt = await retireInactiveAkuma({
    entry: candidate,
    now,
    retireUnderCustody: async (retire) => {
      assert.equal(
        (await recordTell(allocated.paths, { kind: "tell", id: "late-tell", body: "late", recordedAt: OLD })).kind,
        "recorded",
      );
      assert.equal(await retire(), false);
      return "retained";
    },
  });
  assert.equal(receipt, "retained");
  assert.equal(existsSync(allocated.paths.heart), true);
});

test("a wake holding the execution seat keeps the candidate", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-wake-");
  const now = Date.parse("2030-01-01T00:00:00.000Z");
  const allocated = await oldAkuma(world, "e0000005", new Date(now - 20 * DAY_MS).toISOString());
  const candidate = await readRetentionCandidate({ id: allocated.id, paths: allocated.paths }, now);
  assert.ok(candidate !== null);
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  try {
    assert.equal(
      await retireInactiveAkuma({
        entry: candidate,
        now,
        retireUnderCustody: async () => {
          throw new Error("custody must not run while a wake holds the execution seat");
        },
      }),
      "busy",
    );
    assert.equal(existsSync(allocated.paths.heart), true);
  } finally {
    leash.release();
  }
});

test("a busy Alias authority keeps the candidate", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-alias-busy-");
  const allocated = await oldAkuma(world, "e0000002");
  const custody = await tryAcquireAliasCustody(world);
  assert.ok(custody !== null);
  try {
    assert.deepEqual(await sweepInactiveAkumas(world), []);
    assert.equal(existsSync(allocated.paths.heart), true);
  } finally {
    custody.release();
  }
});

test("a busy Dispatch publication seat keeps the candidate", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const repository = await repositoryAt(raw.path);
  const allocated = await oldAkuma(world, "e0000003");
  let release!: () => void;
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seatHeld = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = withPrivateStatePublicationSeat(repository, async () => {
    acquired();
    await held;
  });
  await seatHeld;
  try {
    await assert.rejects(
      withPrivateStatePublicationSeat(repository, async () => undefined, { timeoutMs: 0 }),
      (error) => isPrivateStateSeatContention(error),
    );
    assert.deepEqual(await sweepInactiveAkumas(world), []);
    assert.equal(existsSync(allocated.paths.heart), true);
  } finally {
    release();
    await holder;
  }
});

test("unborn, stillborn, foreign bytes, and noncanonical directories are preserved", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-preserve-");
  const now = Date.parse("2030-01-01T00:00:00.000Z");

  const unborn = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "f0000001" });
  await initializeHeart(unborn.paths);
  ageAkuma(unborn, OLD);

  const stillborn = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "f0000002" });
  await initializeHeart(stillborn.paths);
  const leash = (await HeldAkumaLeash.try(stillborn.paths))!;
  await leash.sealIfUnborn(stillborn.paths, { evidence: "fixture stillborn", at: OLD });
  ageAkuma(stillborn, OLD);

  const foreign = await oldAkuma(world, "f0000003");
  writeFileSync(join(foreign.paths.directory, "foreign.bin"), "keep me\n");
  const noncanonical = join(akumaRunRoot(world), "Bad_Name-12345678");
  mkdirSync(noncanonical);

  assert.deepEqual(await sweepInactiveAkumas(world, { now }), [foreign.id]);
  assert.equal(existsSync(unborn.paths.heart), true);
  assert.equal(existsSync(stillborn.paths.leash), true);
  assert.equal(existsSync(join(foreign.paths.directory, "foreign.bin")), true);
  assert.equal(existsSync(foreign.paths.heart), false);
  assert.equal(existsSync(noncanonical), true);
});

test("one corrupt candidate is retained without failing the sweep or the ordinary list", async (context) => {
  const world = await worldAt(context, "keiyaku-retention-corrupt-");
  const corrupt = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "0bad0001" });
  await initializeHeart(corrupt.paths);
  writeFileSync(corrupt.paths.heart, "not a sqlite database\n");
  ageAkuma(corrupt, OLD);
  const eligible = await oldAkuma(world, "0bad0002");

  const listed = await Akumas.of(world).list();
  assert.equal(existsSync(corrupt.paths.directory), true);
  assert.equal(existsSync(eligible.paths.heart), true, "list alone must not retire");
  assert.ok(listed.rows.every((row) => row.id !== corrupt.id));

  assert.deepEqual(await sweepInactiveAkumas(world), [eligible.id]);
  assert.equal(existsSync(corrupt.paths.directory), true);
  assert.equal(existsSync(eligible.paths.directory), false);
});
