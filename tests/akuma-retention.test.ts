import { driveWithTell } from "./support/akuma-fixtures.js";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { HeldAkumaLeash, initializeHeart, recordTell } from "../src/akuma/heart/index.js";
import { akumaRunRoot, allocateAkumaDirectory, parseAkumaId, pathsForAkumaId, type AllocatedAkuma } from "../src/akuma/identity.js";
import { readRetentionCandidate, retireInactiveAkuma } from "../src/akuma/retention.js";
import { moveAlias, readAliases } from "../src/alias/index.js";
import { contractId } from "../src/core/facts/types.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { isPrivateStateSeatContention, withPrivateStatePublicationSeat } from "../src/git/private-state-seat.js";
import { Settings } from "../src/index.js";
import { sweepInactiveAkumas } from "../src/library/akuma-retention.js";
import { Akumas } from "../src/library/akumas.js";
import { World, type WorldRoot } from "../src/world.js";
import { answering } from "./support/akuma-tell.js";
import { makeGitRepository } from "./support/git.js";
import { accepted, bind, present } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";
import { isolateUserHome } from "./support/user-home.js";

// Retention fixtures own their user Settings, independent of the invoking host's observers.
isolateUserHome();

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
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  await driveWithTell(
    {
      paths: allocated.paths,
      seed: {
        id: allocated.id,
        akumaName: "claude",
        provider: { name: "claude", kind: "claude-agent-sdk" },
        options: {},
        origin: { kind: "direct" },
        cwd: world,
      },
    },
    "old work",
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
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  await leash.birth(allocated.paths, {
    id: allocated.id,
    akumaName: "claude",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    origin: { kind: "direct" },
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
  mkdirSync(join(home, "akumas"), { recursive: true });
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: local\n---\nWork.\n");
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
      "  if (message.method === 'config/read') return reply(message, { config: {} });",
      "  if (message.method === 'thread/start') return reply(message, { thread: { id: 'thread-1' } });",
      "  if (message.method !== 'turn/start') return;",
      "  reply(message, { turn: { id: 'turn-1' } });",
      "  send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: '{\"ok\":true}' } } });",
      "  send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
      "});",
    ].join("\n"),
  );
  chmodSync(executable, 0o755);
  return { home, value: await Settings.load({ cwd: root, home }) };
}

test("a successful call signals confirmed retirement only, after custody is removed", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const trace = join(world, "retired.jsonl");
  mkdirSync(join(world, ".keiyaku"), { recursive: true });
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({
    plugins: { fixture: { package: "./retirement.mjs" } },
  }));
  const oldDirectory = pathsForAkumaId(world, parseAkumaId("aku/claude/a0000001").id).directory;
  writeFileSync(join(world, "retirement.mjs"), `
    import { appendFileSync, existsSync } from "node:fs";
    export default { manifest: {id: "fixture", apiVersion: 1}, activate() {
      return { signals: { "akuma.retired": ({akumaId}) => appendFileSync(
        ${JSON.stringify(trace)}, JSON.stringify({akumaId, exists: existsSync(${JSON.stringify(oldDirectory)})}) + "\\n"
      ) } };
    } };
  `);
  const settingsFixture = await callSettings(raw.path);
  const old = await oldAkuma(world, "a0000001");
  const recent = await oldAkuma(world, "a0000002", new Date().toISOString());

  const listed = await Akumas.of(world).list({ selection: "all" });
  assert.ok(listed.rows?.some((row) => row.id === old.id));
  await Akumas.of(world).status({ akuma: old.id });
  await Akumas.of(world).history({ akuma: old.id });
  await Akumas.of(world).wait({ akuma: [old.id] });
  assert.equal(existsSync(old.paths.heart), true, "read-only observations must not retire");
  assert.equal(existsSync(trace), false);

  const called = await Akumas.of(world).spawn({
    akumaName: "worker",
    body: "ping",
    mode: "wait",
    timeoutMs: 15_000,
    home: settingsFixture.home,
    settings: settingsFixture.value,
  });
  assert.equal(called.kind, "spawned");
  assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    { akumaId: old.id, exists: false },
  ]);
  assert.equal(existsSync(old.paths.directory), false);
  assert.equal(existsSync(recent.paths.heart), true);
  assert.deepEqual(await sweepInactiveAkumas(world), [], "removal is idempotent and the recent entry survives");
  assert.equal(existsSync(recent.paths.heart), true);
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
  await moveAlias({ world, alias: parseAkumaAlias("@kept"), akumaId: aliased.id });
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

test("Dispatch associations keep active and missing Contracts while an abandoned one retires", async () => {
  const raw = repositoryFixture();
  const world = await World.at(raw.path);
  const repository = await repositoryAt(raw.path);

  const active = await oldAkuma(world, "d0000001");
  const abandoned = await oldAkuma(world, "d0000002");
  const missing = await oldAkuma(world, "d0000004");

  const activeContract = await bind(raw);
  const abandonedContract = await bind(raw);
  const activeId = present(await activeContract.state()).id;
  const abandonedId = present(await abandonedContract.state()).id;
  accepted(await abandonedContract.abandon());

  assert.equal((await publishDispatch({ repository, akumaId: active.id, contractId: activeId })).kind, "dispatched");
  assert.equal(
    (await publishDispatch({ repository, akumaId: abandoned.id, contractId: abandonedId })).kind,
    "dispatched",
  );
  assert.equal(
    (await publishDispatch({ repository, akumaId: missing.id, contractId: contractId("kei/never-bound") })).kind,
    "dispatched",
  );

  assert.deepEqual(await sweepInactiveAkumas(world), [abandoned.id]);
  assert.equal(existsSync(active.paths.heart), true);
  assert.equal(existsSync(missing.paths.heart), true);
  assert.equal(existsSync(abandoned.paths.directory), false);
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

  const unborn = await allocateAkumaDirectory({ worldRoot: world, akumaName: "claude", draw: () => "f0000001" });
  await initializeHeart(unborn.paths);
  ageAkuma(unborn, OLD);

  const stillborn = await allocateAkumaDirectory({ worldRoot: world, akumaName: "claude", draw: () => "f0000002" });
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
