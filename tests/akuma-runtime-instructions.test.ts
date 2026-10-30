import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { driveAkumaBody } from "../src/akuma/body.js";
import { keiyakuExecutionInstructions } from "../src/akuma/execution-instructions.js";
import { initializeHeart, readHeart, recordTell } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory, parseAkuId } from "../src/akuma/identity.js";
import { AgentEventChannel, createProviderAttempt, type DriveInput, type ProviderAdapter } from "../src/akuma/provider.js";
import { World } from "../src/world.js";
import { externalRequestCommandsFor } from "../src/body-requests.js";
import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { contractId } from "../src/core/facts/types.js";
import { repositoryAt } from "../src/git/repository.js";
import { makeGitRepository } from "./support/git.js";
import { temporaryDirectory } from "./support/process.js";

function recordingProvider(seen: DriveInput[]): ProviderAdapter {
  const drive = (input: DriveInput) => createProviderAttempt(input.signal, async () => {
    seen.push(input);
    const events = new AgentEventChannel();
    events.emit({ type: "session", coordinate: { sessionId: "native-session" } });
    events.end();
    return {
      admission: { fence: "accepted" },
      events,
      completion: Promise.resolve({ kind: "answered" as const, answer: "done", historyId: `native-${seen.length}` }),
    };
  });
  return { admitOptions: (options) => ({ kind: "admitted", options }), start: drive, resume: drive };
}

test("Body regenerates one runtime section on start and wake, separate from frozen personality", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-runtime-instructions-");
  const world = await World.at(root);
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker" });
  await initializeHeart(allocated.paths);
  const options = { systemPrompt: "Original personality", systemPromptMode: "replace" as const };
  const seed = {
    id: allocated.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" as const },
    options, cwd: root, origin: { kind: "direct" as const }, allowed: [], bare: false,
  };
  const seen: DriveInput[] = [];
  const adapter = recordingProvider(seen);
  const runtime = { world, spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
    executionAssociation: async () => ({ contractId: "kei/work-1234" }) };
  await driveAkumaBody({ paths: allocated.paths, seed, initialBody: "first" }, adapter, runtime);
  await recordTell(allocated.paths, { kind: "tell", id: "next", body: "second", recordedAt: new Date().toISOString() });
  await driveAkumaBody({ paths: allocated.paths }, adapter, {
    world, spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
    executionAssociation: async () => ({ contractId: "kei/work-1234" }),
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.runtimeInstructions, seen[1]!.runtimeInstructions, "publication does not change the intended context");
  const instructions = seen[1]!.runtimeInstructions!;
  assert.equal(instructions.split("<keiyaku>").length - 1, 1);
  assert.match(instructions, new RegExp(allocated.id));
  assert.match(instructions, /Contract context \(not a Dispatch receipt\): kei\/work-1234/u);
  assert.match(instructions, /Use `keiyaku report "\.\.\."` to share updates without stopping your work\./u);
  assert.equal(seen[1]!.body, "");
  assert.deepEqual(seen[1]!.launchTells, [{ id: "next", text: "second" }]);
  assert.deepEqual(seen[1]!.options, options);
  assert.deepEqual((await readHeart(allocated.paths)).soul?.options, options);
});

test("Body composition observes later Dispatch without treating launch metadata or snapshots as authority", async () => {
  const raw = makeGitRepository();
  const world = await World.at(raw.path);
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker" });
  await initializeHeart(allocated.paths);
  const seed = {
    id: allocated.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" as const },
    options: {}, cwd: world, origin: { kind: "direct" as const }, allowed: [],
  };
  const launch = { paths: allocated.paths, seed, completion: { contractId: "kei/launch-intent" } };
  const composition = await externalRequestCommandsFor(launch, {}, noBodyLaunch);
  assert.deepEqual(await composition.executionAssociation(), { contractId: "kei/launch-intent" });
  const admitted = await publishDispatch({ repository: await repositoryAt(world), akuId: allocated.id,
    contractId: contractId("kei/persisted-owner") });
  assert.equal(admitted.kind, "dispatched");
  assert.deepEqual(await composition.executionAssociation(), { contractId: "kei/persisted-owner" },
    "a later read resolves actual Dispatch rather than freezing launch intent");
  await driveAkumaBody({ paths: allocated.paths, seed, initialBody: "work" }, recordingProvider([]), {
    world, spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
  });
  const recovered = await externalRequestCommandsFor({ paths: allocated.paths }, {}, noBodyLaunch);
  assert.deepEqual(await recovered.executionAssociation(), { contractId: "kei/persisted-owner" });
  assert.equal("contractId" in (await readHeart(allocated.paths)).soul!, false);
});

test("bare is frozen in Soul and omits only runtime instructions through wake", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-bare-runtime-");
  const world = await World.at(root);
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker" });
  await initializeHeart(allocated.paths);
  const seen: DriveInput[] = [];
  const seed = {
    id: allocated.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" as const },
    options: { systemPrompt: "Still myself", systemPromptMode: "append" as const },
    cwd: root, origin: { kind: "direct" as const }, allowed: ["debt.add" as const], bare: true,
  };
  const adapter = recordingProvider(seen);
  await driveAkumaBody({ paths: allocated.paths, seed, initialBody: "first" }, adapter, {
    world, spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
  });
  await recordTell(allocated.paths, { kind: "tell", id: "next", body: "second", recordedAt: new Date().toISOString() });
  await driveAkumaBody({ paths: allocated.paths }, adapter, {
    world, spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
    executionAssociation: async () => { throw new Error("bare has no need for optional association"); },
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((input) => input.runtimeInstructions === undefined));
  assert.ok(seen.every((input) => input.options.systemPrompt === "Still myself" && input.requests.dir.length > 0));
  const soul = (await readHeart(allocated.paths)).soul!;
  assert.equal(soul.bare, true);
  assert.deepEqual(soul.allowed, ["debt.add"]);
  assert.equal(keiyakuExecutionInstructions(soul), undefined);
  const own = keiyakuExecutionInstructions({ ...soul, bare: false, id: parseAkuId("aku/worker/1234abcd").id, origin: { kind: "fork", parent: soul.id, at: "turn/1" } });
  assert.match(own!, /aku\/worker\/1234abcd/u);
  assert.equal(own!.includes(soul.id), false, "fork source is lineage, not active identity");
  assert.match(own!, /supersedes any earlier Keiyaku execution context/u);
  const bareFork = keiyakuExecutionInstructions({ ...soul, origin: { kind: "fork", parent: soul.id, at: "turn/1" } });
  assert.equal(bareFork, "Any inherited Keiyaku execution context is inactive for this execution.");
});

test("a prefeature Soul resumes without retrofitting instructions or requiring optional association", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-legacy-runtime-");
  const world = await World.at(root);
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "worker" });
  await initializeHeart(allocated.paths);
  const seen: DriveInput[] = [];
  const adapter = recordingProvider(seen);
  const runtime = { world, spawn: noBodyLaunch, requestSpawn: noBodyLaunch,
    executionAssociation: async () => { throw new Error("legacy execution does not need association"); } };
  await driveAkumaBody({ paths: allocated.paths, seed: {
    id: allocated.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {}, cwd: root, origin: { kind: "direct" }, allowed: [],
  }, initialBody: "first" }, adapter, runtime);
  await recordTell(allocated.paths, { kind: "tell", id: "next", body: "second", recordedAt: new Date().toISOString() });
  await driveAkumaBody({ paths: allocated.paths }, adapter, runtime);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((input) => input.runtimeInstructions === undefined));
});
