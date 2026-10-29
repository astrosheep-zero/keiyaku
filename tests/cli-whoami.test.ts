import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Square } from "@astrosheep/square";
import { Akuma, Keiyaku, Repo, World } from "../src/index.js";
import { HeldAkumaLeash, beginTurn, breakBody, endTurn } from "../src/akuma/heart/index.js";
import { moveAlias } from "../src/alias/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { scopeForRepo } from "../src/library/repo.js";
import { contractId } from "../src/core/facts/types.js";
import { main } from "../src/cli/main.js";
import type { WhoamiFacts } from "../src/cli/commands/whoami.js";
import { renderWhoami } from "../src/cli/render/whoami.js";
import { allocatedHeart } from "./support/akuma-fixtures.js";
import { captureOutput, cliJson, runCli } from "./support/cli-fixtures.js";
import { repositoryWithCommit } from "./support/git.js";
import { accepted } from "./support/library-verbs.js";
import { contractMarkdown } from "./support/markdown.js";
import { temporaryDirectory } from "./support/process.js";

const AT = "2026-08-08T00:00:00.000Z";

function writeSignalRecorder(root: string): string {
  const trace = join(root, "signals.txt");
  mkdirSync(join(root, "plugins"));
  writeFileSync(join(root, "plugins", "record.mjs"), `
    import { appendFileSync } from "node:fs";
    export default {
      manifest: { id: "record", apiVersion: 1 },
      activate(context) { return { signals: {
        "akuma.initiating": (signal) => appendFileSync(context.config.trace, "initiating:" + signal.initiator + "\\n"),
        "akuma.outcome-observed": () => appendFileSync(context.config.trace, "outcome\\n")
      } }; }
    };
  `);
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({
    plugins: { record: { package: "./plugins/record.mjs", config: { trace } } },
  }));
  return trace;
}

test("non-Akuma self is explicit and leaves a fresh directory untouched", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-whoami-empty-");
  const before = readdirSync(root);
  const bare = await cliJson<WhoamiFacts>(["-C", root, "whoami"], { environment: {} });
  assert.equal(bare.exit, 0, bare.stderr);
  assert.deepEqual(bare.value, {
    world: null, self: { kind: "none" }, initiator: null, requests: "local", contract: { kind: "none" },
  });
  const text = await runCli(["whoami"], { cwd: root, environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(text.stdout, "none (not an akuma)\n  world       none\n  context     none\n  requests    local\n");

  const external = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { PI_SESSION_ID: "fresh-seat", SQUARE_INDEX: join(root, "square-index") },
  });
  assert.equal(external.exit, 0, external.stderr);
  assert.deepEqual(external.value.self, { kind: "external", integration: "pi", id: "fresh-seat" });
  assert.equal(external.value.initiator, null);
  assert.equal(external.value.profile, undefined);
  assert.equal("caller" in external.value, false);
  const externalText = await runCli(["-C", root, "whoami"], { environment: { PI_SESSION_ID: "fresh-seat" } });
  assert.equal(externalText.stdout, "pi:fresh-seat (not an akuma)\n  world       none\n  context     none\n  requests    local\n");
  assert.deepEqual(readdirSync(root), before);
  assert.equal(existsSync(join(root, ".keiyaku")), false);
  assert.equal(existsSync(join(root, ".square")), false);
});

test("whoami never reads an existing Square seat or publishes an index", async (t) => {
  const root = await World.at(temporaryDirectory(t, "keiyaku-whoami-seat-"));
  const trace = writeSignalRecorder(root);
  const squareDir = join(root, ".square");
  mkdirSync(squareDir);
  const path = join(squareDir, "KEIYAKU.square");
  const square = await Square.build({ path, markdown: "", body: { channel: "pi", session: "existing" },
    env: { SQUARE_INDEX: join(root, "setup-index") } });
  try { await square.implicitJoin("Existing"); } finally { await square.close(); }
  const before = readFileSync(path);
  const open = t.mock.method(Square, "at");
  const inMemory = t.mock.method(Square, "inMemory");
  const index = join(root, "uncreated", "index.ndjsonl");
  const result = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { PI_SESSION_ID: "existing", SQUARE_INDEX: index },
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.initiator, null);
  assert.equal(open.mock.callCount(), 0, "whoami did not open Square");
  assert.equal(inMemory.mock.callCount(), 0, "whoami did not validate a Square participant");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(trace), false, "whoami did not emit a plugin signal");
  assert.equal(existsSync(join(root, "uncreated")), false, "whoami did not publish a Square discovery index");
});

test("self and request declarations do not adopt outgoing attribution", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-whoami-env-");
  const declared = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { CODEX_THREAD_ID: "session", KEIYAKU_INITIATOR: "  Integration  ", SQUARE_PARTICIPANT_NAME: "Other", AKUMA_REQUESTS: "/missing/route" },
  });
  assert.equal(declared.exit, 0, declared.stderr);
  assert.deepEqual(declared.value.self, { kind: "external", integration: "codex", id: "session" });
  assert.equal(declared.value.initiator, null);
  assert.equal(declared.value.requests, "parent");
  const text = await runCli(["-C", root, "whoami"], {
    environment: { KEIYAKU_EXTERNAL_CALLER: "slack:channel:thread", AKUMA_REQUESTS_ENTRY: "/missing/entry" },
  });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(text.stdout, "slack:channel:thread (not an akuma)\n  world       none\n  context     none\n  requests    parent\n");

  for (const [environment, message] of [
    [{ KEIYAKU_ACTOR_ID: "aku/worker/1234abcd" }, /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u],
    [{ CODEX_THREAD_ID: "one", PI_SESSION_ID: "two" }, /Ambiguous native host caller/u],
    [{ KEIYAKU_EXTERNAL_CALLER: "bad" }, /<integration>:<id>/u],
  ] as const) {
    const result = await cliJson<WhoamiFacts>(["-C", root, "whoami"], { environment });
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.value.self.kind, "invalid");
    assert.equal(result.value.initiator, null);
    assert.equal(result.value.profile, undefined);
    if (result.value.self.kind === "invalid") assert.match(result.value.self.reason, message);
    const readable = await runCli(["-C", root, "whoami"], { environment });
    assert.equal(readable.exit, 0, readable.stderr);
    assert.match(readable.stdout, /^invalid · .+ \(not an akuma\)\n  world       none\n  context     none\n  requests    local\n$/u);
    assert.match(readable.stdout, message);
  }
});

test("Akuma self distinguishes open Turn, birth parent, context and dispatch without signals", async (t) => {
  const repository = repositoryWithCommit();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keiyaku.with().bind({
    repo,
    markdown: contractMarkdown("Whoami fixture", {
      Context: "read-only identity", Objective: "show caller", Design: "observe facts", Region: "src/**",
      Criteria: "### Facts\nReport the caller.",
    }),
    gates: ["reviewed"],
  }));
  const row = (await Keiyaku.with().list({ repo })).rows[0]!;
  assert.ok(row.worktreePath);
  const world = await World.at(repository.path);
  const trace = writeSignalRecorder(world);
  const allocated = await allocatedHeart(world, "worker", "1234abcd");
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  t.after(() => leash.release());
  await leash.birth(allocated.paths, {
    id: allocated.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "fixture-model" }, cwd: row.worktreePath, origin: { kind: "direct" },
    caller: { kind: "external", integration: "fixture", id: "parent" }, allowed: ["akuma.call", "contract.deliver"], createdAt: AT,
  });
  const environment = {
    KEIYAKU_ACTOR_ID: allocated.id, KEIYAKU_ACTOR_WORLD: world,
    KEIYAKU_INITIATOR: "LaterOutgoing", SQUARE_PARTICIPANT_NAME: "OtherSeat",
    AKUMA_REQUESTS_ENTRY: "/missing/channel",
  };
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: AT });
  const beforeTurn = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(beforeTurn.value.initiator, null);
  const previous = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT, initiator: "Previous" });
  await endTurn(allocated.paths, { turnSequence: previous.sequence, completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } } });
  await moveAlias({ world, alias: parseAkumaAlias("@worker"), akuId: allocated.id });
  await moveAlias({ world, alias: parseAkumaAlias("@backup"), akuId: allocated.id });
  assert.equal((await publishDispatch({ repository: scopeForRepo(repo), akuId: allocated.id, contractId: bound.contract })).kind, "dispatched");

  // Prove this fixture really would emit on the ordinary public status read.
  await Akuma.select(world, allocated.id).status();
  const signalsBefore = readFileSync(trace, "utf8");
  assert.match(signalsBefore, /outcome/u);
  const squareOpen = t.mock.method(Square, "at");
  const squareInMemory = t.mock.method(Square, "inMemory");
  const turn = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT, initiator: "CurrentSeat" });
  const result = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.world, world);
  assert.deepEqual(result.value.self, { kind: "akuma", akuId: allocated.id, world });
  assert.equal(result.value.initiator, "CurrentSeat");
  assert.equal("caller" in result.value, false);
  assert.deepEqual(result.value.contract, { kind: "resolved", id: bound.contract });
  assert.deepEqual(result.value.profile, {
    kind: "available", archetype: "worker", aliases: ["@backup", "@worker"], provider: "claude", model: "fixture-model",
    workdir: row.worktreePath, birth: { origin: { kind: "direct" }, caller: { kind: "external", integration: "fixture", id: "parent" } },
    bornAt: AT, allowed: ["akuma.call", "contract.deliver"], contracts: [bound.contract],
  });
  const text = await runCli(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(text.stdout, [
    `${allocated.id} (@backup · @worker) · ${bound.contract}`,
    `  ${row.worktreePath}`,
    "  initiator   CurrentSeat",
    "  parent      fixture:parent",
    `  world       ${world}`,
    "  requests    parent",
    "  runtime     claude · fixture-model",
    "",
  ].join("\n"));
  assert.doesNotMatch(text.stdout, /running|asleep|elapsed|timeline/u);
  assert.equal(readFileSync(trace, "utf8"), signalsBefore, "neither outcome nor initiating signal was emitted");

  assert.ok(result.value.profile?.kind === "available");
  const alternateContext = contractId("kei/different");
  assert.ok(renderWhoami({ ...result.value, contract: { kind: "resolved", id: alternateContext } })
    .includes(`\n  context     ${alternateContext}\n`));
  assert.equal(renderWhoami({
    ...result.value,
    contract: { kind: "unavailable", reason: "missing\nstate" },
    profile: {
      ...result.value.profile, workdir: null, provider: null, model: null,
      birth: { ...result.value.profile.birth, origin: { kind: "request", parent: allocated.id, requestId: "request\nid" } },
    },
  }), [
    `${allocated.id} (@backup · @worker) · ${bound.contract}`,
    "  initiator   CurrentSeat",
    "  parent      fixture:parent",
    `  world       ${world}`,
    "  context     unavailable · missing state",
    "  requests    parent",
    "  runtime     unknown · unknown",
    `  origin      request · ${allocated.id} · request id`,
  ].join("\n"));

  const elsewhere = temporaryDirectory(t, "keiyaku-whoami-other-world-");
  const crossWorld = await cliJson<WhoamiFacts>(["-C", elsewhere, "whoami"], { environment });
  assert.equal(crossWorld.value.world, null);
  assert.equal(crossWorld.value.contract.kind, "none");
  assert.deepEqual(crossWorld.value.profile, result.value.profile, "profile and dispatch belong to the caller's World");
  const crossWorldText = await runCli(["-C", elsewhere, "whoami"], { environment });
  assert.ok(crossWorldText.stdout.includes("\n  context     none\n"));
  const missing = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], {
    environment: { ...environment, KEIYAKU_ACTOR_ID: "aku/worker/ffffffff" },
  });
  assert.equal(missing.exit, 0, missing.stderr);
  assert.equal(missing.value.profile?.kind, "unavailable");
  assert.deepEqual(missing.value.contract, { kind: "resolved", id: bound.contract });
  const missingText = await runCli(["-C", row.worktreePath, "whoami"], {
    environment: { ...environment, KEIYAKU_ACTOR_ID: "aku/worker/ffffffff" },
  });
  assert.equal(missingText.exit, 0, missingText.stderr);
  assert.match(missingText.stdout, /profile\s+unavailable/u);
  assert.ok(missingText.stdout.includes(bound.contract));
  const outside = await cliJson<WhoamiFacts>(["-C", repository.path, "whoami"], { environment: {} });
  assert.equal(outside.value.contract.kind, "none");

  await endTurn(allocated.paths, { turnSequence: turn.sequence, completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } } });
  const endedTurn = await runCli(["-C", row.worktreePath, "whoami"], { environment });
  assert.match(endedTurn.stdout, /\n  initiator   none\n/u);
  const noInitiator = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT });
  assert.equal((await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment })).value.initiator, null);
  await endTurn(allocated.paths, { turnSequence: noInitiator.sequence, completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } } });

  const free = await allocatedHeart(world, "worker", "5678abcd");
  const freeLeash = (await HeldAkumaLeash.try(free.paths))!;
  t.after(() => freeLeash.release());
  await freeLeash.birth(free.paths, {
    id: free.id, archetype: "worker", provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {}, cwd: row.worktreePath, origin: { kind: "fork", parent: allocated.id, at: "turn/1" }, allowed: [], createdAt: AT,
  });
  const freeEnvironment = { ...environment, KEIYAKU_ACTOR_ID: free.id };
  const freeFacts = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment: freeEnvironment });
  assert.deepEqual(freeFacts.value.contract, { kind: "resolved", id: bound.contract });
  assert.equal(freeFacts.value.profile?.kind, "available");
  if (freeFacts.value.profile?.kind === "available") assert.deepEqual(freeFacts.value.profile.contracts, []);
  const freeText = await runCli(["-C", row.worktreePath, "whoami"], { environment: freeEnvironment });
  assert.equal(freeText.stdout, [
    `${free.id}`,
    `  ${row.worktreePath}`,
    "  initiator   none",
    "  parent      unknown",
    `  world       ${world}`,
    `  context     ${bound.contract}`,
    "  requests    parent",
    "  runtime     claude · unknown",
    `  origin      fork · ${allocated.id} · turn/1`,
    "",
  ].join("\n"));

  await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT, initiator: "OnlyWhileOpen" });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  const unreadableAliases = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(unreadableAliases.exit, 0, unreadableAliases.stderr);
  assert.equal(unreadableAliases.value.profile?.kind, "unavailable");
  assert.equal(unreadableAliases.value.initiator, "OnlyWhileOpen");
  assert.deepEqual(unreadableAliases.value.contract, { kind: "resolved", id: bound.contract });
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: AT });
  const endedBody = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(endedBody.value.initiator, null, "an open historical Turn in an ended Body is not current");

  leash.release();
  const successor = (await HeldAkumaLeash.try(allocated.paths))!;
  t.after(() => successor.release());
  const newBody = await successor.recordBody(allocated.paths, { leashTakenAt: AT });
  assert.equal((await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment })).value.initiator, null,
    "a new Body does not inherit the predecessor's open historical Turn");
  await beginTurn(allocated.paths, { bodySequence: newBody.sequence, startedAt: AT, initiator: "Successor" });
  assert.equal((await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment })).value.initiator, "Successor");
  await successor.recordBodyHung(allocated.paths, { sequence: newBody.sequence, diagnostic: "fixture", at: AT });
  assert.equal((await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment })).value.initiator, null,
    "a hung Body is terminal even when its end field is absent");

  const corruptHeart = new DatabaseSync(free.paths.heart);
  corruptHeart.exec("DELETE FROM akuma_schema");
  corruptHeart.close();
  const unreadableHeart = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment: freeEnvironment });
  assert.equal(unreadableHeart.value.initiator, null);
  assert.match(unreadableHeart.value.initiatorUnavailable ?? "", /heart schema version/u);
  const unreadableText = await runCli(["-C", row.worktreePath, "whoami"], { environment: freeEnvironment });
  assert.match(unreadableText.stdout, /\n  initiator   unavailable · .*heart schema version/u);
  assert.deepEqual(unreadableHeart.value.contract, { kind: "resolved", id: bound.contract });
  assert.equal(squareOpen.mock.callCount(), 0);
  assert.equal(squareInMemory.mock.callCount(), 0);
  assert.equal(readFileSync(trace, "utf8"), signalsBefore);
});

test("unreadable Contract authority is unavailable instead of inventing no context", async () => {
  const repository = repositoryWithCommit();
  await World.at(repository.path);
  repository.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  const result = await cliJson<WhoamiFacts>(["-C", repository.path, "whoami"], { environment: {} });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.world, repository.path);
  assert.equal(result.value.contract.kind, "unavailable");
  assert.deepEqual(result.value.self, { kind: "none" });
});

test("an unestablished Git World is absent, and usage/help need no World", async (t) => {
  const repository = repositoryWithCommit();
  const result = await cliJson<WhoamiFacts>(["-C", repository.path, "whoami"], { environment: {} });
  assert.equal(result.value.world, null);
  assert.equal(existsSync(join(repository.path, ".keiyaku")), false);
  const root = temporaryDirectory(t, "keiyaku-whoami-help-");
  for (const args of [["whoami", "extra"], ["whoami", "--unknown"], ["whoami", "--json", "--json"]]) {
    const refused = await captureOutput(() => main(["-C", root, ...args]));
    assert.equal(refused.exit, 64, args.join(" "));
    assert.match(refused.stderr, /usage\s+keiyaku whoami/u);
    assert.equal(refused.stdout, "");
  }
  for (const args of [["--help"], ["whoami", "--help"]]) {
    const help = await captureOutput(() => main(["-C", "/missing/whoami/world", ...args]));
    assert.equal(help.exit, 0, help.stderr);
    assert.match(help.stdout, /whoami/u);
  }
  assert.deepEqual(readdirSync(root), []);
});
