import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Square } from "@astrosheep/square";
import { Akuma, Keiyaku, Repo, World } from "../src/index.js";
import { HeldAkumaLeash, beginTurn, endTurn, finishBodyIfIdle } from "../src/akuma/heart/index.js";
import { moveAlias } from "../src/alias/index.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { scopeForRepo } from "../src/library/repo.js";
import { main } from "../src/cli/main.js";
import type { WhoamiFacts } from "../src/cli/commands/whoami.js";
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

test("bare caller facts are explicit and leave a fresh directory untouched", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-whoami-empty-");
  const before = readdirSync(root);
  const bare = await cliJson<WhoamiFacts>(["-C", root, "whoami"], { environment: {} });
  assert.equal(bare.exit, 0, bare.stderr);
  assert.deepEqual(bare.value, {
    world: null, caller: { kind: "none" }, initiator: null, requests: "local", contract: { kind: "none" },
  });
  const text = await runCli(["whoami"], { cwd: root, environment: {} });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /^world\s+none\ncaller\s+none\ninitiator\s+none\nrequests\s+local\ncontract\s+none\n$/u);

  const seat = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { PI_SESSION_ID: "fresh-seat", SQUARE_INDEX: join(root, "square-index") },
  });
  assert.equal(seat.exit, 0, seat.stderr);
  assert.deepEqual(seat.value.caller, { kind: "external", integration: "pi", id: "fresh-seat" });
  assert.equal(seat.value.initiator?.source, "square");
  assert.match(seat.value.initiator?.name ?? "", /^keiyaku-assigned-/u);
  assert.deepEqual(readdirSync(root), before);
  assert.equal(existsSync(join(root, ".keiyaku")), false);
  assert.equal(existsSync(join(root, ".square")), false);
});

test("an existing Square seat is observed without publishing an index or changing the artifact", async (t) => {
  const root = await World.at(temporaryDirectory(t, "keiyaku-whoami-seat-"));
  const trace = writeSignalRecorder(root);
  const squareDir = join(root, ".square");
  mkdirSync(squareDir);
  const path = join(squareDir, "KEIYAKU.square");
  const square = await Square.build({ path, markdown: "", body: { channel: "pi", session: "existing" },
    env: { SQUARE_INDEX: join(root, "setup-index") } });
  try { await square.implicitJoin("Existing"); } finally { await square.close(); }
  const before = readFileSync(path);
  const index = join(root, "uncreated", "index.ndjsonl");
  const result = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { PI_SESSION_ID: "existing", SQUARE_INDEX: index },
  });
  assert.equal(result.exit, 0, result.stderr);
  assert.deepEqual(result.value.initiator, { name: "Existing", source: "square" });
  assert.deepEqual(readFileSync(path), before);
  assert.equal(existsSync(trace), false, "whoami did not prepare a participant");
  assert.equal(existsSync(join(root, "uncreated")), false, "a read must not publish a Square discovery index");

  const told = await runCli(["-C", root, "tell", "aku/worker/ffffffff", "hello"], {
    environment: { PI_SESSION_ID: "existing", SQUARE_INDEX: index },
  });
  assert.equal(told.exit, 1, told.stderr);
  assert.equal(existsSync(index), true, "a submitting command still publishes Square discovery as before");
  assert.equal(readFileSync(trace, "utf8"), "initiating:Existing\n", "the submitter attributes the same seat");
});

test("caller, initiator and request declarations remain independent", async (t) => {
  const root = temporaryDirectory(t, "keiyaku-whoami-env-");
  const declared = await cliJson<WhoamiFacts>(["-C", root, "whoami"], {
    environment: { CODEX_THREAD_ID: "session", KEIYAKU_INITIATOR: "  Integration  ", SQUARE_PARTICIPANT_NAME: "Other", AKUMA_REQUESTS: "/missing/route" },
  });
  assert.equal(declared.exit, 0, declared.stderr);
  assert.deepEqual(declared.value.caller, { kind: "external", integration: "codex", id: "session" });
  assert.deepEqual(declared.value.initiator, { name: "Integration", source: "declared" });
  assert.equal(declared.value.requests, "parent");
  const text = await runCli(["-C", root, "whoami"], {
    environment: { KEIYAKU_EXTERNAL_CALLER: "slack:channel:thread", AKUMA_REQUESTS_ENTRY: "/missing/entry" },
  });
  assert.equal(text.exit, 0, text.stderr);
  assert.match(text.stdout, /caller\s+slack:channel:thread/u);
  assert.match(text.stdout, /initiator\s+none/u);
  assert.match(text.stdout, /requests\s+parent/u);

  for (const [environment, message] of [
    [{ KEIYAKU_ACTOR_ID: "aku/worker/1234abcd" }, /both KEIYAKU_ACTOR_ID and KEIYAKU_ACTOR_WORLD/u],
    [{ CODEX_THREAD_ID: "one", PI_SESSION_ID: "two" }, /Ambiguous native host caller/u],
    [{ KEIYAKU_EXTERNAL_CALLER: "bad" }, /<integration>:<id>/u],
  ] as const) {
    const result = await cliJson<WhoamiFacts>(["-C", root, "whoami"], { environment });
    assert.equal(result.exit, 0, result.stderr);
    assert.equal(result.value.caller.kind, "invalid");
    if (result.value.caller.kind === "invalid") assert.match(result.value.caller.reason, message);
    const readable = await runCli(["-C", root, "whoami"], { environment });
    assert.equal(readable.exit, 0, readable.stderr);
    assert.match(readable.stdout, /caller\s+invalid/u);
    assert.match(readable.stdout, message);
  }
});

test("a born caller's profile reads its own World and the invocation's Contract without signals", async (t) => {
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
  const body = await leash.recordBody(allocated.paths, { leashTakenAt: AT });
  const turn = await beginTurn(allocated.paths, { bodySequence: body.sequence, startedAt: AT });
  await endTurn(allocated.paths, { turnSequence: turn.sequence, completedAt: AT,
    outcome: { kind: "answered", answer: "done", session: { sessionId: "fixture" } } });
  await finishBodyIfIdle(allocated.paths, { sequence: body.sequence, at: AT });
  leash.release();
  await moveAlias({ world, alias: parseAkumaAlias("@worker"), akuId: allocated.id });
  await moveAlias({ world, alias: parseAkumaAlias("@backup"), akuId: allocated.id });
  assert.equal((await publishDispatch({ repository: scopeForRepo(repo), akuId: allocated.id, contractId: bound.contract })).kind, "dispatched");

  // Prove this fixture really would emit on the ordinary public status read.
  await Akuma.select(world, allocated.id).status();
  const signalsBefore = readFileSync(trace, "utf8");
  assert.match(signalsBefore, /outcome/u);
  const environment = { KEIYAKU_ACTOR_ID: allocated.id, KEIYAKU_ACTOR_WORLD: world, KEIYAKU_INITIATOR: "Fixture", AKUMA_REQUESTS_ENTRY: "/missing/channel" };
  const result = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(result.exit, 0, result.stderr);
  assert.equal(result.value.world, world);
  assert.deepEqual(result.value.caller, { kind: "akuma", akuId: allocated.id, world });
  assert.deepEqual(result.value.contract, { kind: "resolved", id: bound.contract });
  assert.deepEqual(result.value.profile, {
    kind: "available", archetype: "worker", aliases: ["@backup", "@worker"], provider: "claude", model: "fixture-model",
    workdir: row.worktreePath, birth: { origin: { kind: "direct" }, caller: { kind: "external", integration: "fixture", id: "parent" } },
    bornAt: AT, allowed: ["akuma.call", "contract.deliver"], contracts: [bound.contract],
  });
  const text = await runCli(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(text.exit, 0, text.stderr);
  for (const expected of [allocated.id, "@worker", "claude", "fixture-model", row.worktreePath, "fixture:parent", "akuma.call", bound.contract, AT]) {
    assert.ok(text.stdout.includes(expected), text.stdout);
  }
  assert.doesNotMatch(text.stdout, /running|asleep|elapsed|timeline/u);
  assert.equal(readFileSync(trace, "utf8"), signalsBefore, "neither outcome nor initiating signal was emitted");

  const elsewhere = temporaryDirectory(t, "keiyaku-whoami-other-world-");
  const crossWorld = await cliJson<WhoamiFacts>(["-C", elsewhere, "whoami"], { environment });
  assert.equal(crossWorld.value.world, null);
  assert.equal(crossWorld.value.contract.kind, "none");
  assert.deepEqual(crossWorld.value.profile, result.value.profile, "profile and dispatch belong to the caller's World");
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

  writeFileSync(join(world, ".keiyaku", "akuma", "alias.json"), "corrupt\n");
  const unreadableAliases = await cliJson<WhoamiFacts>(["-C", row.worktreePath, "whoami"], { environment });
  assert.equal(unreadableAliases.exit, 0, unreadableAliases.stderr);
  assert.equal(unreadableAliases.value.profile?.kind, "unavailable");
  assert.deepEqual(unreadableAliases.value.contract, { kind: "resolved", id: bound.contract });
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
  assert.deepEqual(result.value.caller, { kind: "none" });
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
