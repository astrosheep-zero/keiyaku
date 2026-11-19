import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Square, harnessOwner } from "@astrosheep/square";
import { Akuma, Keis, Repo, World } from "../src/index.js";
import { HeldAkumaLeash, beginTurn, breakBody, endTurn, type Soul } from "../src/akuma/heart/index.js";
import { LEASH_SCHEMA, HEART_SCHEMA } from "../src/akuma/heart/schema.js";
import { encodeSoulRow } from "../src/akuma/heart/soul.js";
import { allocateAkumaDirectory, type AkumaId, type AkumaPaths } from "../src/akuma/identity.js";
import {
  GIT_REF,
  readGitPaths,
  repositoryAt,
  updateGitTree,
  updateRefsAtomically,
  writeBlob,
  writeStateCommit,
} from "../src/git/repository.js";
import type { GitRepository } from "../src/git/process.js";
import { moveAlias } from "../src/alias/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { scopeForRepo } from "../src/library/repo.js";
import { contractId } from "../src/core/facts/types.js";
import { main } from "../src/cli/main.js";
import type { WhoamiFacts } from "../src/library/keiyaku-identity.js";
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
  writeFileSync(
    join(root, "plugins", "record.mjs"),
    `
    import { appendFileSync } from "node:fs";
    export default {
      manifest: { id: "record", apiVersion: 1 },
      activate(context) { return { signals: {
        "akuma.outcome-observed": () => appendFileSync(context.config.trace, "outcome\\n")
      } }; }
    };
  `,
  );
  writeFileSync(
    join(root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: { record: { package: "./plugins/record.mjs", config: { trace } } },
    }),
  );
  return trace;
}

test("non-Akuma self is explicit and leaves a fresh directory untouched", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-whoami-empty-");
  const before = readdirSync(root);
  const bare = await cliJson<WhoamiFacts>(["-C", root, "whoami"], { environment: {} });
  assert.equal(bare.exit, 0, bare.stderr);
  assert.deepEqual(bare.value, { self: { kind: "none" } });
  const text = await runCli(["whoami"], { cwd: root, environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(text.stdout, "none (not an akuma)\n  world       none\n  context     none\n");

  const external = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { PI_SESSION_ID: "fresh-seat", SQUARE_INDEX: join(root, "square-index") },
  });
  assert.equal(external.exit, 0, external.stderr);
  assert.deepEqual(external.value.self, { kind: "external", id: "pi:fresh-seat" });
  assert.equal(external.value.initiator, undefined);
  assert.equal(external.value.profileUnavailable, undefined);
  assert.equal("caller" in external.value, false);
  const externalText = await runCli(["-C", root, "whoami"], { environment: { PI_SESSION_ID: "fresh-seat" } });
  assert.equal(externalText.stdout, "pi:fresh-seat (not an akuma)\n  world       none\n  context     none\n");
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
  const square = await Square.build({
    path,
    markdown: "",
    ledgerLocation: join(root, "delivery.sqlite"),
  });
  try {
    await square.join("Existing", { owner: harnessOwner({ channel: "pi", session: "existing" }) });
  } finally {
    await square.close();
  }
  const before = readFileSync(path);
  const open = t.mock.method(Square, "at");
  const inMemory = t.mock.method(Square, "inMemory");
  const index = join(root, "uncreated", "index.ndjsonl");
  const result = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { PI_SESSION_ID: "existing", SQUARE_INDEX: index },
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.initiator, undefined);
  assert.equal(open.mock.callCount(), 0, "whoami did not open Square");
  assert.equal(inMemory.mock.callCount(), 0, "whoami did not validate a Square participant");
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(trace), false, "whoami did not emit a plugin signal");
  assert.equal(existsSync(join(root, "uncreated")), false, "whoami did not publish a Square discovery index");
});

test("self declarations do not adopt outgoing attribution", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-whoami-env-");
  const declared = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { CODEX_THREAD_ID: "session", KEIYAKU_INITIATOR: "  Integration  " },
  });
  assert.equal(declared.exit, 0, declared.stderr);
  assert.deepEqual(declared.value.self, { kind: "external", id: "codex:session" });
  assert.equal(declared.value.initiator, undefined);
  const text = await runCli(["-C", root, "whoami"], {
    environment: { KEIYAKU_EXTERNAL_CALLER: "slack:channel:thread" },
  });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(text.stdout, "slack:channel:thread (not an akuma)\n  world       none\n  context     none\n");

  for (const [environment, message] of [
    [{ KEIYAKU_ACTOR_ID: "aku/worker/1234abcd" }, /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u],
    [{ CODEX_THREAD_ID: "one", PI_SESSION_ID: "two" }, /Ambiguous native host caller: CODEX_THREAD_ID, PI_SESSION_ID/u],
    [{ KEIYAKU_EXTERNAL_CALLER: "bad" }, /<integration>:<id>/u],
  ] as const) {
    const result = await cliJson<WhoamiFacts>(["-C", root, "whoami"], { environment });
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.value.self.kind, "invalid");
    assert.equal(result.value.initiator, undefined);
    assert.equal(result.value.profileUnavailable, undefined);
    if (result.value.self.kind === "invalid") assert.match(result.value.self.diagnostic, message);
    const readable = await runCli(["-C", root, "whoami"], { environment });
    assert.equal(readable.exit, 0, readable.stderr);
    assert.match(readable.stdout, /^invalid · .+ \(not an akuma\)\n  world       none\n  context     none\n$/u);
    assert.match(readable.stdout, message);
  }
});

test("Akuma self distinguishes open Turn, birth parent, context and dispatch without signals", async (t) => {
  const repository = repositoryWithCommit();
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(
    await Keis.of(repo).bind({
      terms: contractMarkdown("Whoami fixture", {
        Context: "read-only identity",
        Objective: "show caller",
        Design: "observe facts",
        Region: "src/**",
        Criteria: "### Facts\nReport the caller.",
      }),
      gates: ["reviewed"],
    }),
  );
  const catalogue = await Keis.of(repo).list({});
  const first = catalogue.rows?.[0];
  assert.ok(first !== undefined, "the bound Contract appears in the live catalogue");
  const observation = await Keis.of(repo).observe({ id: first.id });
  assert.equal(observation.kind, "present");
  if (observation.kind !== "present") assert.fail("the bound Contract has an exact observation");
  const workspace = observation.row.workspace;
  if (!("path" in workspace)) assert.fail("the bound Contract has an appointed worktree");
  const worktreePath = workspace.path;
  assert.ok(worktreePath);
  const world = await World.at(repository.path);
  const trace = writeSignalRecorder(world);
  const allocated = await allocatedHeart(world, "worker", "1234abcd");
  const leash = (await HeldAkumaLeash.try(allocated.paths))!;
  t.after(() => leash.release());
  await leash.birth(allocated.paths, {
    id: allocated.id,
    akumaName: "worker",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "fixture-model" },
    cwd: worktreePath,
    origin: { kind: "direct" },
    caller: { kind: "external", integration: "fixture", id: "parent" },
    createdAt: AT,
  });
  const environment = {
    KEIYAKU_ACTOR_ID: allocated.id,
    KEIYAKU_ACTOR_WORLD: world,
    KEIYAKU_INITIATOR: "LaterOutgoing",
  };
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: AT });
  const beforeTurn = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment });
  assert.equal(beforeTurn.value.initiator, undefined);
  const previous = await beginTurn(allocated.paths, {
    bodySequence: body.sequence,
    startedAt: AT,
    initiator: "Previous",
  });
  await endTurn(allocated.paths, {
    turnSequence: previous.sequence,
    completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } },
  });
  await moveAlias({ world, alias: parseAkumaAlias("@worker"), akumaId: allocated.id });
  await moveAlias({ world, alias: parseAkumaAlias("@backup"), akumaId: allocated.id });
  assert.equal(
    (await publishDispatch({ repository: scopeForRepo(repo), akumaId: allocated.id, contractId: bound.contractId }))
      .kind,
    "dispatched",
  );

  // Prove this fixture really would emit on the ordinary public status read.
  await Akuma.select(world, allocated.id).status();
  const signalsBefore = readFileSync(trace, "utf8");
  assert.match(signalsBefore, /outcome/u);
  const squareOpen = t.mock.method(Square, "at");
  const squareInMemory = t.mock.method(Square, "inMemory");
  const turn = await beginTurn(allocated.paths, {
    bodySequence: body.sequence,
    startedAt: AT,
    initiator: "CurrentSeat",
  });
  const result = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.world, undefined, "a World matching self is not repeated");
  assert.deepEqual(result.value.self, { kind: "akuma", akumaId: allocated.id, world });
  assert.equal(result.value.initiator, "CurrentSeat");
  assert.equal("caller" in result.value, false);
  assert.equal(result.value.contextContract, bound.contractId);
  assert.deepEqual(result.value.aliases, ["@backup", "@worker"]);
  assert.equal(result.value.provider, "claude");
  assert.equal(result.value.model, "fixture-model");
  assert.equal(result.value.workdir, worktreePath);
  assert.equal(result.value.dispatchContract, bound.contractId);
  assert.deepEqual(result.value.birthCaller, { kind: "external", id: "fixture:parent" });
  assert.equal(result.value.forkOrigin, undefined);
  const text = await runCli(["-C", worktreePath, "whoami"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  assert.equal(
    text.stdout,
    [
      `${allocated.id} (@backup · @worker) · ${bound.contractId}`,
      `  ${worktreePath}`,
      "  initiator   CurrentSeat",
      "  parent      fixture:parent",
      `  world       ${world}`,
      "  runtime     claude · fixture-model",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(text.stdout, /running|asleep|elapsed|timeline/u);
  assert.equal(readFileSync(trace, "utf8"), signalsBefore, "no outcome signal was emitted");

  const alternateContext = contractId("kei/different");
  assert.ok(
    renderWhoami({ ...result.value, contextContract: alternateContext }).includes(
      `\n  context     ${alternateContext}\n`,
    ),
  );
  const { workdir: _workdir, provider: _provider, model: _model, ...unknownRuntime } = result.value;
  assert.equal(
    renderWhoami({
      ...unknownRuntime,
      contextContract: { kind: "unavailable", diagnostic: "missing\nstate" },
      forkOrigin: allocated.id,
    }),
    [
      `${allocated.id} (@backup · @worker) · ${bound.contractId}`,
      "  initiator   CurrentSeat",
      "  parent      fixture:parent",
      `  world       ${world}`,
      "  context     unavailable · missing state",
      "  runtime     unknown · unknown",
    ].join("\n"),
  );

  const elsewhere = temporaryDirectory(t, "keiyaku-whoami-other-world-");
  const crossWorld = await cliJson<WhoamiFacts>(["-C", elsewhere, "whoami"], { environment });
  assert.equal(crossWorld.value.world, undefined);
  assert.equal(crossWorld.value.contextContract, undefined);
  for (const key of [
    "aliases",
    "provider",
    "model",
    "workdir",
    "dispatchContract",
    "birthCaller",
    "forkOrigin",
    "profileUnavailable",
  ] as const)
    assert.deepEqual(
      crossWorld.value[key],
      result.value[key],
      `profile and dispatch belong to the caller's World (${key})`,
    );
  const crossWorldText = await runCli(["-C", elsewhere, "whoami"], { environment });
  assert.ok(crossWorldText.stdout.includes("\n  context     none\n"));
  const missing = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], {
    environment: { ...environment, KEIYAKU_ACTOR_ID: "aku/worker/ffffffff" },
  });
  assert.equal(missing.exit, 0, missing.stderr);
  assert.match(missing.value.profileUnavailable ?? "", /not born|Akuma/u);
  assert.equal(missing.value.contextContract, bound.contractId);
  const missingText = await runCli(["-C", worktreePath, "whoami"], {
    environment: { ...environment, KEIYAKU_ACTOR_ID: "aku/worker/ffffffff" },
  });
  assert.equal(missingText.exit, 0, missingText.stderr);
  assert.match(missingText.stdout, /profile\s+unavailable/u);
  assert.ok(missingText.stdout.includes(bound.contractId));
  const outside = await cliJson<WhoamiFacts>(["-C", repository.path, "whoami"], { environment: {} });
  assert.equal(outside.value.contextContract, undefined);

  await endTurn(allocated.paths, {
    turnSequence: turn.sequence,
    completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } },
  });
  const endedTurn = await runCli(["-C", worktreePath, "whoami"], { environment });
  assert.match(endedTurn.stdout, /\n  initiator   none\n/u);
  const noInitiator = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT });
  assert.equal(
    (await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment })).value.initiator,
    undefined,
  );
  await endTurn(allocated.paths, {
    turnSequence: noInitiator.sequence,
    completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } },
  });

  const free = await allocatedHeart(world, "worker", "5678abcd");
  const freeLeash = (await HeldAkumaLeash.try(free.paths))!;
  t.after(() => freeLeash.release());
  await freeLeash.birth(free.paths, {
    id: free.id,
    akumaName: "worker",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    cwd: worktreePath,
    origin: { kind: "fork", parent: allocated.id, at: "turn/1" },
    createdAt: AT,
  });
  const freeEnvironment = { ...environment, KEIYAKU_ACTOR_ID: free.id };
  const freeFacts = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment: freeEnvironment });
  assert.equal(freeFacts.value.contextContract, bound.contractId);
  assert.equal(freeFacts.value.dispatchContract, undefined);
  assert.equal(freeFacts.value.workdir, worktreePath);
  assert.deepEqual(freeFacts.value.birthCaller, { kind: "unknown" });
  assert.deepEqual(freeFacts.value.forkOrigin, allocated.id);
  const freeText = await runCli(["-C", worktreePath, "whoami"], { environment: freeEnvironment });
  assert.equal(
    freeText.stdout,
    [
      `${free.id}`,
      `  ${worktreePath}`,
      "  initiator   none",
      "  parent      unknown",
      `  world       ${world}`,
      `  context     ${bound.contractId}`,
      "  runtime     claude · unknown",
      "",
    ].join("\n"),
  );

  await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT, initiator: "OnlyWhileOpen" });
  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  const unreadableAliases = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment });
  assert.equal(unreadableAliases.exit, 0, unreadableAliases.stderr);
  assert.match(unreadableAliases.value.profileUnavailable ?? "", /alias/u);
  assert.equal(unreadableAliases.value.initiator, "OnlyWhileOpen");
  assert.equal(unreadableAliases.value.contextContract, bound.contractId);
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: AT });
  const endedBody = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment });
  assert.equal(endedBody.value.initiator, undefined, "an open historical Turn in an ended Body is not current");

  leash.release();
  const successor = (await HeldAkumaLeash.try(allocated.paths))!;
  t.after(() => successor.release());
  const newBody = await successor.recordBody(allocated.paths, { leashTakenAt: AT });
  assert.equal(
    (await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment })).value.initiator,
    undefined,
    "a new Body does not inherit the predecessor's open historical Turn",
  );
  await beginTurn(allocated.paths, { bodySequence: newBody.sequence, startedAt: AT, initiator: "Successor" });
  assert.equal(
    (await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment })).value.initiator,
    "Successor",
  );
  await successor.recordBodyHung(allocated.paths, { sequence: newBody.sequence, diagnostic: "fixture", at: AT });
  assert.equal(
    (await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment })).value.initiator,
    undefined,
    "a hung Body is terminal even when its end field is absent",
  );

  const corruptHeart = new DatabaseSync(free.paths.heart);
  corruptHeart.exec("DELETE FROM akuma_schema");
  corruptHeart.close();
  const unreadableHeart = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], {
    environment: freeEnvironment,
  });
  const initiator = unreadableHeart.value.initiator;
  assert.equal(typeof initiator === "object" ? initiator.kind : undefined, "unavailable");
  if (typeof initiator === "object" && initiator.kind === "unavailable")
    assert.match(initiator.diagnostic, /heart schema version/u);
  const unreadableText = await runCli(["-C", worktreePath, "whoami"], { environment: freeEnvironment });
  assert.match(unreadableText.stdout, /\n  initiator   unavailable · .*heart schema version/u);
  assert.equal(unreadableHeart.value.contextContract, bound.contractId);
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
  const context = result.value.contextContract;
  assert.equal(typeof context === "object" ? context.kind : undefined, "unavailable");
  assert.deepEqual(result.value.self, { kind: "none" });
});

test("an unestablished Git World is absent, and usage/help need no World", async (t) => {
  const repository = repositoryWithCommit();
  const result = await cliJson<WhoamiFacts>(["-C", repository.path, "whoami"], { environment: {} });
  assert.equal(result.value.world, undefined);
  assert.equal(existsSync(join(repository.path, ".keiyaku")), false);
  const root = temporaryDirectory(t, "keiyaku-whoami-help-");
  for (const args of [
    ["whoami", "extra"],
    ["whoami", "--unknown"],
    ["whoami", "--json", "--json"],
  ]) {
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

/**
 * Retained v31 DDL derived from the checked-in v29 authority through the
 * documented 30 and 31 schema steps: a cancelled Turn outcome and retained
 * reports, with the retired request table removed.
 */
function legacyHeartV31Schema(): string {
  return (
    readFileSync("tests/fixtures/heart-v29.sql", "utf8")
      .replace("version = 29", "version = 31")
      .replace("VALUES (1, 29)", "VALUES (1, 31)")
      .replace("'answered', 'failed', 'invalid-output'", "'answered', 'failed', 'invalid-output', 'canceled'")
      .replace(
        "    OR (outcome IS NULL",
        `    OR (outcome = 'canceled' AND history_id IS NULL AND session_json IS NULL AND answer IS NULL
      AND answer_json IS NULL AND diagnostic IS NULL)
    OR (outcome IS NULL`,
      )
      .replace("'tell', 'turn-end'", "'tell', 'turn-end', 'report'") +
    `
      DROP TABLE requests;
      CREATE TABLE reports (
        sequence INTEGER PRIMARY KEY REFERENCES timeline(sequence) ON DELETE CASCADE,
        body_sequence INTEGER NOT NULL REFERENCES bodies(sequence),
        turn_sequence INTEGER NOT NULL REFERENCES turns(sequence) ON DELETE CASCADE,
        text TEXT NOT NULL,
        at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX reports_by_turn ON reports(turn_sequence);`
  );
}

function custodyBytes(directory: string): Map<string, Buffer> {
  return new Map(readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name))]));
}

function schemaVersion(path: string): bigint | undefined {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const query = database.prepare("SELECT version FROM akuma_schema");
    query.setReadBigInts(true);
    return query.get()?.version as bigint | undefined;
  } finally {
    database.close();
  }
}

/** One Soul with an open, non-hung Body and one open Turn carrying its initiator. */
function seedOpenActor(database: DatabaseSync, soul: Soul, initiator: string): void {
  database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  database.prepare("INSERT INTO soul VALUES (1, ?)").run(...encodeSoulRow(soul));
  database.prepare("INSERT INTO bodies VALUES (1, ?, NULL, NULL, NULL, NULL)").run(AT);
  database.exec("INSERT INTO timeline VALUES (1, 'turn-start')");
  database.prepare("INSERT INTO turns (sequence, body_sequence, started_at, initiator) VALUES (1, 1, ?, ?)").run(
    AT,
    initiator,
  );
  database.exec("COMMIT");
}

/** Move a committed WAL-mode seed into the actor custody, preserving its WAL. */
function seedCustody(paths: AkumaPaths, seed: string, log: string): void {
  const leash = new DatabaseSync(paths.leash);
  try {
    leash.exec(LEASH_SCHEMA);
  } finally {
    leash.close();
  }
  writeFileSync(paths.log, log);
  for (const suffix of ["", "-wal", "-shm"]) copyFileSync(seed + suffix, paths.heart + suffix);
}

/** A repository World with one current-format Heart actor ready for authority composition. */
async function currentAuthorityFixture(draw: string) {
  const repository = repositoryWithCommit();
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "worker", draw: () => draw });
  const soul: Soul = {
    id: allocated.id,
    akumaName: "worker",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "current-model" },
    cwd: world,
    origin: { kind: "direct" },
    caller: { kind: "external", integration: "current", id: "parent" },
    createdAt: AT,
  };
  const seed = join(world, "current-heart.db");
  const database = new DatabaseSync(seed);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    database.exec(HEART_SCHEMA);
    seedOpenActor(database, soul, "CurrentSeat");
    seedCustody(allocated.paths, seed, "current execution log\n");
  } finally {
    database.close();
  }
  return { repository, world, repo, allocated, soul };
}

function dispatchFactPath(akumaId: AkumaId): string {
  return `dispatch/${createHash("sha256").update(akumaId).digest("hex")}.json`;
}

/** Replace one durable Dispatch fact, leaving every other state-tree entry intact. */
async function corruptDispatchFact(repository: GitRepository, akumaId: AkumaId, bytes: string): Promise<void> {
  const snapshot = await readGitPaths(repository, []);
  const blob = await writeBlob(repository, Buffer.from(bytes));
  const tree = await updateGitTree(repository, snapshot.tree, new Map([[dispatchFactPath(akumaId), { oid: blob }]]));
  const commit = await writeStateCommit({
    repository,
    tree,
    parent: snapshot.commit,
    message: `corrupt ${akumaId}`,
    at: new Date().toISOString(),
  });
  assert.deepEqual(
    await updateRefsAtomically(repository, [{ ref: GIT_REF, newOid: commit, expectedOid: snapshot.commit }]),
    { kind: "published" },
  );
}

// The declared Core 03 successor makes ordinary reads refuse this predecessor;
// on a v31 build the same fixture is current, so this regression is meaningful
// only on that candidate.
test("whoami observes a populated legacy Heart without converting it", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-whoami-legacy-"));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "worker", draw: () => "1234abcd" });
  const soul: Soul = {
    id: allocated.id,
    akumaName: "worker",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "legacy-model" },
    cwd: world,
    origin: { kind: "direct" },
    caller: { kind: "external", integration: "legacy", id: "parent" },
    createdAt: AT,
  };
  const seed = join(world, "legacy-heart.db");
  const database = new DatabaseSync(seed);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    database.exec(legacyHeartV31Schema());
    seedOpenActor(database, soul, "LegacySeat");
    seedCustody(allocated.paths, seed, "retained execution log\n");
  } finally {
    database.close();
  }

  const before = custodyBytes(allocated.paths.directory);
  assert.ok(before.get("heart.db-wal")!.length > 0, "fixture retains a populated WAL");
  const environment = { KEIYAKU_ACTOR_ID: allocated.id, KEIYAKU_ACTOR_WORLD: world };
  const result = await cliJson<WhoamiFacts>(["-C", world, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.value.self, { kind: "akuma", akumaId: allocated.id, world });
  const initiator = result.value.initiator;
  assert.equal(typeof initiator === "object" ? initiator.kind : undefined, "unavailable");
  if (typeof initiator === "object" && initiator.kind === "unavailable")
    assert.match(initiator.diagnostic, /schema version must be 32; found 31/u);
  assert.match(result.value.profileUnavailable ?? "", /schema version must be 32; found 31/u);
  const text = await runCli(["-C", world, "whoami"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /initiator\s+unavailable · .*schema version must be 32; found 31/u);
  assert.match(text.stdout, /profile\s+unavailable · .*schema version must be 32; found 31/u);

  const after = custodyBytes(allocated.paths.directory);
  for (const name of ["heart.db", "heart.db-wal", "leash.db", "stdio.log"])
    assert.deepEqual(after.get(name), before.get(name), name);
  const check = new DatabaseSync(allocated.paths.heart, { readOnly: true });
  try {
    const version = check.prepare("SELECT version FROM akuma_schema");
    version.setReadBigInts(true);
    assert.equal(version.get()?.version, 31n);
    assert.deepEqual(check.prepare("SELECT name FROM sqlite_schema WHERE name = 'tell_terminal_receipts'").all(), []);
  } finally {
    check.close();
  }
});

test("whoami observes a populated current Heart without changing its WAL", async (t) => {
  const world = await World.at(temporaryDirectory(t, "keiyaku-whoami-current-"));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "worker", draw: () => "5678abcd" });
  const soul: Soul = {
    id: allocated.id,
    akumaName: "worker",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "current-model" },
    cwd: world,
    origin: { kind: "direct" },
    caller: { kind: "external", integration: "current", id: "parent" },
    createdAt: AT,
  };
  const seed = join(world, "current-heart.db");
  const database = new DatabaseSync(seed);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    database.exec(HEART_SCHEMA);
    seedOpenActor(database, soul, "CurrentSeat");
    seedCustody(allocated.paths, seed, "current execution log\n");
  } finally {
    database.close();
  }

  const before = custodyBytes(allocated.paths.directory);
  const versionBefore = schemaVersion(allocated.paths.heart);
  assert.ok(before.get("heart.db-wal")!.length > 0, "fixture retains a populated WAL");
  const environment = { KEIYAKU_ACTOR_ID: allocated.id, KEIYAKU_ACTOR_WORLD: world };
  const result = await cliJson<WhoamiFacts>(["-C", world, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.value.self, { kind: "akuma", akumaId: allocated.id, world });
  assert.equal(result.value.initiator, "CurrentSeat");
  assert.equal(result.value.provider, "claude");
  assert.equal(result.value.model, "current-model");
  assert.equal(result.value.workdir, world);
  assert.deepEqual(result.value.birthCaller, { kind: "external", id: "current:parent" });
  assert.equal(result.value.profileUnavailable, undefined);
  assert.equal(schemaVersion(allocated.paths.heart), versionBefore);

  const after = custodyBytes(allocated.paths.directory);
  for (const name of ["heart.db", "heart.db-wal", "leash.db", "stdio.log"])
    assert.deepEqual(after.get(name), before.get(name), name);
});

test("whoami keeps Alias and Dispatch facts when the actor Heart is unavailable", async () => {
  const repository = repositoryWithCommit();
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: repository.path });
  const allocated = await allocateAkumaDirectory({ worldRoot: world, akumaName: "worker", draw: () => "9abc1234" });
  const soul: Soul = {
    id: allocated.id,
    akumaName: "worker",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "legacy-model" },
    cwd: world,
    origin: { kind: "direct" },
    caller: { kind: "external", integration: "legacy", id: "parent" },
    createdAt: AT,
  };
  const seed = join(world, "legacy-heart.db");
  const database = new DatabaseSync(seed);
  try {
    database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    database.exec(legacyHeartV31Schema());
    seedOpenActor(database, soul, "LegacySeat");
    seedCustody(allocated.paths, seed, "retained execution log\n");
  } finally {
    database.close();
  }
  await moveAlias({ world, alias: parseAkumaAlias("@legacy"), akumaId: allocated.id });
  const contract = contractId("kei/dispatched-authority");
  const publication = await publishDispatch({ repository: scopeForRepo(repo), akumaId: allocated.id, contractId: contract });
  assert.equal(publication.kind, "dispatched");

  const environment = { KEIYAKU_ACTOR_ID: allocated.id, KEIYAKU_ACTOR_WORLD: world };
  const result = await cliJson<WhoamiFacts>(["-C", world, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.value.self, { kind: "akuma", akumaId: allocated.id, world });
  assert.deepEqual(result.value.aliases, ["@legacy"]);
  assert.equal(result.value.dispatchContract, contract);
  assert.match(result.value.profileUnavailable ?? "", /schema version must be 32; found 31/u);
  assert.equal(typeof result.value.initiator === "object" ? result.value.initiator.kind : undefined, "unavailable");
  assert.equal(result.value.provider, undefined);
  assert.equal(result.value.workdir, undefined);
  assert.equal(schemaVersion(allocated.paths.heart), 31n);

  const text = await runCli(["-C", world, "whoami"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /\(@legacy\) · kei\/dispatched-authority/u);
  assert.match(text.stdout, /profile\s+unavailable · .*schema version must be 32; found 31/u);
});

test("whoami keeps Dispatch and Heart profile when Alias authority is corrupt", async () => {
  const fixture = await currentAuthorityFixture("a1b2c3d4");
  const contract = contractId("kei/alias-corrupt-dispatch");
  assert.equal(
    (await publishDispatch({ repository: scopeForRepo(fixture.repo), akumaId: fixture.allocated.id, contractId: contract }))
      .kind,
    "dispatched",
  );
  writeFileSync(join(fixture.world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");

  const environment = { KEIYAKU_ACTOR_ID: fixture.allocated.id, KEIYAKU_ACTOR_WORLD: fixture.world };
  const result = await cliJson<WhoamiFacts>(["-C", fixture.world, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.aliases, undefined);
  assert.equal(result.value.dispatchContract, contract);
  assert.match(result.value.profileUnavailable ?? "", /invalid Alias JSON/u);
  assert.equal(result.value.provider, "claude");
  assert.equal(result.value.model, "current-model");
  assert.equal(result.value.workdir, fixture.world);
  assert.deepEqual(result.value.birthCaller, { kind: "external", id: "current:parent" });
  assert.equal(result.value.initiator, "CurrentSeat");
  const text = await runCli(["-C", fixture.world, "whoami"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(
    text.stdout,
    /profile\s+unavailable · .*invalid Alias JSON[\s\S]*runtime\s+claude · current-model/u,
  );
});

test("whoami keeps Alias and Heart profile when Dispatch authority is corrupt", async () => {
  const fixture = await currentAuthorityFixture("b2c3d4e5");
  await moveAlias({ world: fixture.world, alias: parseAkumaAlias("@kept"), akumaId: fixture.allocated.id });
  const contract = contractId("kei/dispatch-corrupt-alias");
  assert.equal(
    (await publishDispatch({ repository: scopeForRepo(fixture.repo), akumaId: fixture.allocated.id, contractId: contract }))
      .kind,
    "dispatched",
  );
  const repository = await repositoryAt(fixture.world);
  await corruptDispatchFact(repository, fixture.allocated.id, '{"akumaId":"aku/worker/00000002","contractId":"kei/x"}\n');

  const environment = { KEIYAKU_ACTOR_ID: fixture.allocated.id, KEIYAKU_ACTOR_WORLD: fixture.world };
  const result = await cliJson<WhoamiFacts>(["-C", fixture.world, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.value.aliases, ["@kept"]);
  assert.equal(result.value.dispatchContract, undefined);
  assert.match(result.value.profileUnavailable ?? "", /Dispatch has invalid fields/u);
  assert.equal(result.value.provider, "claude");
  assert.equal(result.value.model, "current-model");
  assert.equal(result.value.workdir, fixture.world);
  assert.deepEqual(result.value.birthCaller, { kind: "external", id: "current:parent" });
  assert.equal(result.value.initiator, "CurrentSeat");
});
