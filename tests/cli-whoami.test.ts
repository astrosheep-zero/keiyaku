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
import { allocateAkumaDirectory, type AkumaId } from "../src/akuma/identity.js";
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
  assert.match(text.stdout, /^none \(not an akuma\)/mu);

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
  const { worktreePath } = bound;
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
  const missing = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], {
    environment: { ...environment, KEIYAKU_ACTOR_ID: "aku/worker/ffffffff" },
  });
  assert.equal(missing.exit, 0, missing.stderr);
  assert.match(missing.value.profileUnavailable ?? "", /not born|Akuma/u);
  assert.equal(missing.value.initiator, undefined);
  assert.equal(missing.value.contextContract, bound.contractId);
  const outside = await cliJson<WhoamiFacts>(["-C", repository.path, "whoami"], { environment: {} });
  assert.equal(outside.value.contextContract, undefined);

  await endTurn(allocated.paths, {
    turnSequence: turn.sequence,
    completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } },
  });
  const endedTurn = await runCli(["-C", worktreePath, "whoami"], { environment });
  assert.match(endedTurn.stdout, /^\s*initiator\s+none\s*$/mu);

  await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT, initiator: "OnlyWhileOpen" });
  const aliasPath = join(world, ".keiyaku", "akuma", "alias.json");
  writeFileSync(aliasPath, "corrupt\n");
  const unreadableAliases = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment });
  assert.equal(unreadableAliases.exit, 0, unreadableAliases.stderr);
  assert.match(unreadableAliases.value.profileUnavailable ?? "", /alias/u);
  assert.equal(unreadableAliases.value.initiator, "OnlyWhileOpen");
  assert.equal(unreadableAliases.value.contextContract, bound.contractId);
  assert.equal(unreadableAliases.value.aliases, undefined);
  assert.equal(unreadableAliases.value.dispatchContract, bound.contractId);
  assert.equal(unreadableAliases.value.provider, "claude");
  assert.equal(unreadableAliases.value.model, "fixture-model");
  assert.match(renderWhoami(unreadableAliases.value), /profile\s+unavailable · .*invalid Alias JSON[\s\S]*runtime\s+claude · fixture-model/u);
  await breakBody(allocated.paths, { sequence: body.sequence, end: "put-down", at: AT });
  const endedBody = await cliJson<WhoamiFacts>(["-C", worktreePath, "whoami"], { environment });
  assert.equal(endedBody.value.initiator, undefined, "an open historical Turn in an ended Body is not current");


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

test("whoami preserves current WAL and keeps Alias and Heart readable when Dispatch fails", async () => {
  const repository = repositoryWithCommit();
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: world });
  const { id, paths } = await allocateAkumaDirectory({ worldRoot: world, akumaName: "worker", draw: () => "5678abcd" });
  const soul: Soul = {
    id, akumaName: "worker", provider: { name: "claude", kind: "claude-agent-sdk" },
    options: { model: "current-model" }, cwd: world, origin: { kind: "direct" },
    caller: { kind: "external", integration: "current", id: "parent" }, createdAt: AT,
  };
  const seed = join(world, "current-heart.db");
  const database = new DatabaseSync(seed);
  try {
    database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ${HEART_SCHEMA}
      PRAGMA foreign_keys=ON; BEGIN IMMEDIATE`);
    database.prepare("INSERT INTO soul VALUES (1, ?)").run(...encodeSoulRow(soul));
    database.prepare("INSERT INTO bodies VALUES (1, ?, NULL, NULL, NULL, NULL)").run(AT);
    database.exec("INSERT INTO timeline VALUES (1, 'turn-start')");
    database.prepare("INSERT INTO turns (sequence, body_sequence, started_at, initiator) VALUES (1, 1, ?, 'CurrentSeat')").run(AT);
    database.exec("COMMIT");
    for (const suffix of ["", "-wal", "-shm"]) copyFileSync(seed + suffix, paths.heart + suffix);
  } finally {
    database.close();
  }
  const leash = new DatabaseSync(paths.leash);
  try {
    leash.exec(LEASH_SCHEMA);
  } finally {
    leash.close();
  }
  writeFileSync(paths.log, "current execution log\n");
  const files = [paths.heart, `${paths.heart}-wal`, paths.leash, paths.log];
  const before = files.map((file) => readFileSync(file));
  assert.ok(before[1]!.length > 0, "fixture retains a populated WAL");

  const contract = contractId("kei/dispatch-corrupt-alias");
  await moveAlias({ world, alias: parseAkumaAlias("@kept"), akumaId: id });
  await publishDispatch({ repository: scopeForRepo(repo), akumaId: id, contractId: contract });
  await corruptDispatchFact(await repositoryAt(world), id, '{"akumaId":"aku/worker/00000002","contractId":"kei/x"}\n');

  const environment = { KEIYAKU_ACTOR_ID: id, KEIYAKU_ACTOR_WORLD: world };
  const result = await cliJson<WhoamiFacts>(["-C", world, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.value.self, { kind: "akuma", akumaId: id, world });
  assert.deepEqual(result.value.aliases, ["@kept"]);
  assert.equal(result.value.dispatchContract, undefined);
  assert.match(result.value.profileUnavailable ?? "", /Dispatch has invalid fields/u);
  assert.equal(result.value.provider, "claude");
  assert.equal(result.value.model, "current-model");
  assert.equal(result.value.workdir, world);
  assert.deepEqual(result.value.birthCaller, { kind: "external", id: "current:parent" });
  assert.equal(result.value.initiator, "CurrentSeat");
  assert.deepEqual(files.map((file) => readFileSync(file)), before);
});
