import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Keis, Repo, World, Keiyaku } from "../src/index.js";
import { akumaTellResultSchema, akumaAskResultSchema } from "../src/akuma/selection-observation.js";
import { spawnResultSchema, forkResultSchema } from "../src/library/akuma-creation.js";
import { akumasWithLauncher } from "../src/library/akumas.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { createProviderAttempt } from "../src/akuma/provider.js";
import { readSoul, readTell } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { readAliases, moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { classifyVerb, type VerbInput, type VerbOutput, type VerbRun } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { KeiyakuError } from "../src/index.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import type { SpawnProgress } from "../src/library/akuma-creation.js";
import type { AskProgress } from "../src/akuma/akuma-selection-execution.js";
import { runCli } from "./support/cli-fixtures.js";
import { answering, bornWorld, fixtureLauncher, settleFixtureBodies } from "./support/akuma-tell.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";
import { temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip, assertWireConformance } from "./support/schema-parity.js";

const context = { columns: 100, color: false };

async function mcpCall(t: TestContext, cwd: string, name: "spawn" | "tell", input: VerbInput<"spawn" | "tell">, value: VerbOutput<"spawn" | "tell">) {
  const adapter = createKeiyakuMcpServer({ cwd, environment: { HOME: cwd, USERPROFILE: cwd }, version: "test" });
  const client = new Client({ name: "test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([adapter.server.connect(serverTransport), client.connect(clientTransport)]);
  const run = t.mock.method(Keiyaku.prototype, "run", async () => value);
  try { return await client.callTool({ name, arguments: input }); }
  finally { run.mock.restore(); await client.close(); await adapter.close(); }
}

test("creation keeps birth, Tell and ordered association/observation failures", async (t) => {
  const repository = repositoryWithMain();
  t.after(() => rmSync(repository.path, { recursive: true, force: true }));
  const world = await World.at(repository.path);
  const repo = await Repo.at({ path: world });
  const bound = accepted(await Keis.of(repo).bind({ markdown: document(), target: null, gates: [] }));
  const home = temporaryDirectory(t, "call-outcome-home-");
  mkdirSync(join(home, "akumas"));
  writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const bodies: Promise<unknown>[] = [];
  t.after(() => settleFixtureBodies(bodies));
  const api = akumasWithLauncher(world, (launch) => fixtureLauncher(bodies,
    new Map([[launch.paths.directory, { adapter: answering("exact text answer"), now: "2026-11-11T00:00:00.000Z" }]]))(launch));
  const parent = await api.spawn({ akumaName: "worker", home, cwd: world, body: "source", mode: "wait" });
  assert.equal(parent.kind, "spawned");
  const git = await repositoryAt(world);
  assert.equal((await publishDispatch({ repository: git, akumaId: parent.akumaId, contractId: bound.contractId })).kind, "dispatched");
  const alias = parseAkumaAlias("@unchanged");
  await moveAlias({ world, alias, akumaId: parent.akumaId });
  writeFileSync(join(git.commonDirectory, "refs", "heads", "keiyaku-state.lock"), "fixture publication stop\n");
  const input = { akumaName: "worker", prompt: "answer", mode: "wait" as const };
  const progress: SpawnProgress[] = [];
  const result = await api.spawn({ akumaName: "worker", home, cwd: world, body: input.prompt, mode: "wait", contract: bound.kei, alias, observe: {
    admitted: (tell, id, head) => { progress.push({ kind: "admitted", tell, id, head }); },
    observe: (observation) => { progress.push({ kind: "live", observation }); },
  } });
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") assert.fail("Dispatch must stop the operation");
  assert.deepEqual(result.failures.map(failure => failure.stage), ["dispatch"]);
  assert.deepEqual(result.input, { kind: "answered", answer: "exact text answer" });
  assert.equal((await readSoul(pathsForAkumaId(world, result.akumaId)))?.id, result.akumaId);
  assert.ok(result.tellId);
  assert.equal((await readTell(pathsForAkumaId(world, result.akumaId), result.tellId))?.body, "answer");
  assert.deepEqual(await readAliases(world), [{ alias, akumaId: parent.akumaId }]);
  assertWireRoundTrip(spawnResultSchema, result);
  const completion = { kind: "returned" as const, value: result };
  assert.equal(classifyVerb("spawn", input, completion), "failed");
  const text = renderVerb("spawn", input, completion, context);
  for (const evidence of [result.akumaId, result.tellId, "dispatch failed", "exact text answer"]) assert.ok(text.includes(evidence), text);
  const streamRun = t.mock.method(Keiyaku.prototype, "run", async (_name: string, _input: unknown, run?: VerbRun<SpawnProgress>) => {
    for (const event of progress) await run?.observe?.(event);
    return result;
  });
  try {
    const cli = await runCli(["-C", world, "spawn", "worker", "--wait", "60s", "answer"]);
    assert.equal(cli.exit, 3, cli.stderr);
    assert.equal(cli.stdout, "exact text answer");
    for (const evidence of [result.akumaId, result.tellId, "dispatch failed"]) assert.ok(cli.stderr.includes(evidence), cli.stderr);
  } finally { streamRun.mock.restore(); }

  const failedObservation = t.mock.method(AkumaOwner.prototype, "tellOutcome", async () => { throw new Error("observation unavailable"); });
  const stopped = await api.spawn({ akumaName: "worker", home, cwd: world, body: "again", mode: "wait", contract: bound.kei });
  failedObservation.mock.restore();
  assert.equal(stopped.kind, "failed");
  if (stopped.kind !== "failed") assert.fail("expected independent stops");
  assert.deepEqual(stopped.failures.map(failure => failure.stage), ["dispatch", "observation"]);
  assertWireRoundTrip(spawnResultSchema, stopped);

  const originalFork = claudeProvider.fork;
  Reflect.set(claudeProvider, "fork", () => createProviderAttempt(undefined, async () => ({ session: { sessionId: "forked-session" } })));
  t.after(() => Reflect.set(claudeProvider, "fork", originalFork));
  const history = await api.history({ akuma: parent.akumaId });
  assert.equal(history.kind, "akuma");
  if (history.kind !== "akuma") assert.fail("expected history");
  const turn = history.events.find(row => row.kind === "outcome");
  assert.ok(turn);
  const child = await api.fork({ akuma: parent.akumaId, at: `turn/${turn.turnSequence}`, repo });
  Reflect.set(claudeProvider, "fork", originalFork);
  assert.equal(child.kind, "failed");
  if (child.kind !== "failed") assert.fail("fork association must stop after birth");
  assert.equal(child.failure.stage, "dispatch");
  assert.equal((await readSoul(pathsForAkumaId(world, child.childAkumaId)))?.id, child.childAkumaId);
  assertWireRoundTrip(forkResultSchema, child);
  assert.equal(classifyVerb("fork", { akuma: parent.akumaId, at: `turn/${turn.turnSequence}` }, { kind: "returned", value: child }), "failed");

  const brokenAlias = join(world, ".keiyaku", "akuma", "alias.json");
  writeFileSync(brokenAlias, "unavailable Alias authority\n");
  const aliasStopped = await api.spawn({ akumaName: "worker", home, cwd: world, body: "alias answer", mode: "wait", alias });
  assert.equal(aliasStopped.kind, "failed");
  if (aliasStopped.kind !== "failed") assert.fail("Alias must stop after birth");
  assert.deepEqual(aliasStopped.failures.map(failure => failure.stage), ["alias"]);
  const aliasText = renderVerb("spawn", input, { kind: "returned", value: aliasStopped }, context);
  assert.match(aliasText, /alias failed/u);
  assert.ok(aliasText.includes("exact text answer"));
  assertWireRoundTrip(spawnResultSchema, aliasStopped);

  const response = await mcpCall(t, world, "spawn", input, result);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.deepEqual(response.content, [{ type: "text", text: `failed\n${text}` }]);
});

test("Tell failure and exact Ask precedence retain answer and historical wake recovery evidence", async (t) => {
  const root = temporaryDirectory(t, "call-answer-evidence-");
  const fixture = await bornWorld(root, "feeda110");
  const bodies: Promise<unknown>[] = [];
  const launcher = fixtureLauncher(bodies, new Map([[fixture.allocated.paths.directory,
    { adapter: answering('{"ok":true}'), now: "2026-11-11T00:00:00.000Z" }]]));
  t.after(() => settleFixtureBodies(bodies));
  const api = akumasWithLauncher(fixture.world, launcher);
  const original = await api.tell({ akuma: fixture.allocated.id, body: "answer", wait: true });

  assert.equal(original.kind, "admitted");
  const fact = await readTell(fixture.allocated.paths, original.tellId);
  assert.ok(fact);
  const receipt = await new AkumaOwner(fixture.allocated.id, fixture.world).admittedReceipt(original.tellId);
  const logPath = fixture.allocated.paths.log;
  const nativeFailure = Object.freeze(new TypeError("unexpected wake rejection"));
  const rejected = t.mock.method(AkumaOwner.prototype, "admitTell", async () => ({ kind: "admitted", tell: fact, wake: Promise.reject(nativeFailure) }));
  await assert.rejects(api.tell({ akuma: fixture.allocated.id, body: "answer" }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.cause, nativeFailure);
    assert.equal(error.tell?.tellId, original.tellId);
    return true;
  });
  rejected.mock.restore();
  t.mock.method(AkumaOwner.prototype, "admitTell", async () => ({ kind: "admitted", tell: fact,
    wake: Promise.resolve({ ...receipt, wake: { kind: "failed", diagnostic: "historical wake failed", child: { log: { path: logPath } } } }) }));
  const input = { akuma: fixture.allocated.id, prompt: "answer", schema: {} };
  const progress: AskProgress[] = [];
  const told = await api.tell({ akuma: fixture.allocated.id, body: "answer", wait: true, observe: {
    admitted: (tell, id) => { progress.push({ kind: "admitted", tell, id }); },
    observe: (observation) => { progress.push({ kind: "live", observation }); },
  } });
  assert.equal(told.kind, "failed");
  if (told.kind !== "failed") assert.fail("Tell must keep its wake stop");
  assert.deepEqual(told.failures, [{ stage: "wake", diagnostic: "historical wake failed", logPath }]);
  assert.deepEqual(told.input, { kind: "answered", answer: '{"ok":true}' });
  assertWireRoundTrip(akumaTellResultSchema, told);
  assert.equal(classifyVerb("tell", input, { kind: "returned", value: told }), "failed");
  const toldText = renderVerb("tell", input, { kind: "returned", value: told }, context);
  const streamRun = t.mock.method(Keiyaku.prototype, "run", async (_name: string, _input: unknown, run?: VerbRun<AskProgress>) => {
    for (const event of progress) await run?.observe?.(event);
    return told;
  });
  try {
    const cli = await runCli(["-C", root, "tell", fixture.allocated.id, "--wait", "60s", "answer"]);
    assert.equal(cli.exit, 3, cli.stderr);
    assert.equal(cli.stdout, '{"ok":true}');
    for (const evidence of [original.tellId, fixture.allocated.id, "historical wake failed", logPath]) assert.ok(cli.stderr.includes(evidence), cli.stderr);
  } finally { streamRun.mock.restore(); }
  const asked = await api.ask({ akuma: fixture.allocated.id, body: "answer", schema: {} });
  assert.equal(asked.kind, "answered");
  if (asked.kind !== "answered") assert.fail("exact answer must win");
  assert.deepEqual(asked.answer, { ok: true });
  assertWireRoundTrip(akumaAskResultSchema, asked);
  assertWireConformance(Keiyaku.verbs.ask.normal, asked);
  assert.equal(classifyVerb("ask", input, { kind: "returned", value: asked }), "accepted");
  const askText = renderVerb("ask", input, { kind: "returned", value: asked }, context);
  for (const text of [toldText, askText]) for (const evidence of [original.tellId, fixture.allocated.id, "historical wake failed", logPath, '{"ok":true}']) assert.ok(text.includes(evidence), text);
  const { wake: _wake, ...pure } = asked;
  assert.equal(renderVerb("ask", input, { kind: "returned", value: pure }, context), '{"ok":true}');
  const failedObservation = t.mock.method(AkumaOwner.prototype, "tellOutcome", async () => ({ reason: "completed", outcome: { kind: "failed", diagnostic: "observed failure" }, completedAt: null }));
  const stopped = await api.tell({ akuma: fixture.allocated.id, body: "answer", wait: true });
  failedObservation.mock.restore();
  assert.equal(stopped.kind, "failed");
  if (stopped.kind !== "failed") assert.fail("expected both stops");
  assert.deepEqual(stopped.failures.map(failure => failure.stage), ["wake", "observation"]);
  assertWireRoundTrip(akumaTellResultSchema, stopped);
  const response = await mcpCall(t, root, "tell", input, told);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.deepEqual(response.content, [{ type: "text", text: `failed\n${toldText}` }]);
});

test("shared frozen Tell failures keep native cause and each invocation's admission", async (t) => {
  const root = temporaryDirectory(t, "shared-tell-failure-");
  const reasons = [
    Object.freeze(new AuthorityCorruptionError("shared native authority failure")),
    Object.freeze(new KeiyakuError("invalid-input", "shared caller reason", { cause: new TypeError("native caller cause") })),
  ];
  let reason: KeiyakuError = reasons[0]!;
  let controller = new AbortController();
  const { akuma, allocated } = await bornWorld(root, "feeda111", async () => {
    controller.abort(reason);
    throw reason;
  });
  for (reason of reasons) {
    const errors: KeiyakuError[] = [];
    for (const body of ["first", "second"]) {
      controller = new AbortController();
      await assert.rejects(akuma.tell(body, { signal: controller.signal }), (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        errors.push(error);
        return true;
      });
    }
    assert.notEqual(errors[0], errors[1]);
    assert.notEqual(errors[0]!.tell?.tellId, errors[1]!.tell?.tellId);
    for (const [index, failure] of errors.entries()) {
      assert.equal(failure.cause, reason);
      assert.equal(failure.category, reason.category);
      assert.equal(failure.tell?.akumaId, akuma.id);
      assert.ok(failure.tell?.tellId);
      assert.equal((await readTell(allocated.paths, failure.tell.tellId))?.body, ["first", "second"][index]);
    }
  }
});
