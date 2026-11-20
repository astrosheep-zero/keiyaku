import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseSync } from "node:sqlite";
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
import { pendingTellReceipt } from "../src/akuma/call-initial-tell.js";
import { claudeProvider } from "../src/akuma/providers/claude/index.js";
import { createProviderAttempt, type DriveInput, type TurnResult } from "../src/akuma/provider.js";
import { HeldAkumaLeash, activitySlice, beginTurn, endTurn, finishBodyIfIdle, probeLeash, readHeart, readSoul, readTell, readTurn } from "../src/akuma/heart/index.js";
import { pathsForAkumaId } from "../src/akuma/identity.js";
import { readAliases, moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { publishDispatch } from "../src/dispatch/index.js";
import { repositoryAt } from "../src/git/repository.js";
import { classifyVerb, type VerbInput, type VerbOutput } from "../src/library/keiyaku-verbs.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { KeiyakuError } from "../src/index.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";
import { answering, bornWorld, fixtureAdapter, fixtureLauncher, settleFixtureBodies, settledInput } from "./support/akuma-tell.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { assertWireRoundTrip, assertWireConformance } from "./support/schema-parity.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

const context = { columns: 100, color: false };

async function mcpCall(t: TestContext, cwd: string, name: "tell", input: VerbInput<"tell">, value: VerbOutput<"tell">) {
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
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: null, gates: [] }));
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
  const input = { akumaName: "worker", prompt: "answer" };
  const result = await api.spawn({ akumaName: "worker", home, cwd: world, body: input.prompt, mode: "wait", contract: bound.kei, alias });
  assert.ok(result.kind === "failed", "Dispatch must stop the operation");
  assert.deepEqual(result.failures.map(failure => failure.stage), ["dispatch"]);
  assert.equal(result.requestedContractId, bound.contractId);
  assert.equal(result.requestedAlias, alias);
  assert.deepEqual(settledInput(result.input), { kind: "answered", answer: "exact text answer" });
  assert.equal((await readSoul(pathsForAkumaId(world, result.akumaId)))?.id, result.akumaId);
  assert.ok(result.tellId);
  assert.equal((await readTell(pathsForAkumaId(world, result.akumaId), result.tellId))?.body, "answer");
  assert.deepEqual(await readAliases(world), [{ alias, akumaId: parent.akumaId }]);
  assertWireRoundTrip(spawnResultSchema, result);
  const completion = { kind: "returned" as const, value: result };
  assert.equal(classifyVerb("spawn", input, completion), "failed");
  const text = renderVerb("spawn", input, completion, context);
  assert.equal(text.split("\n")[0], `! ${result.akumaId} born · dispatch failed · do not respawn`);
  assert.ok(text.includes(`input ${result.tellId} admitted`), text);

  const stopped = await api.spawn({ akumaName: "worker", home, cwd: world, body: "again", mode: "wait", contract: bound.kei,
    observe: { observe() { throw new Error("observation unavailable"); } } });
  assert.ok(stopped.kind === "failed", "expected independent stops");
  assert.deepEqual(stopped.failures.map(failure => failure.stage), ["dispatch", "observation"]);
  assertWireRoundTrip(spawnResultSchema, stopped);

  const originalFork = claudeProvider.fork;
  Reflect.set(claudeProvider, "fork", () => createProviderAttempt(undefined, async () => ({ session: { sessionId: "forked-session" } })));
  t.after(() => Reflect.set(claudeProvider, "fork", originalFork));
  const latest = await api.history({ akuma: parent.akumaId, last: true });
  assert.ok(latest.kind === "akuma-answer");
  const child = await api.fork({ akuma: parent.akumaId, at: latest.turn, repo });
  assert.ok(child.kind === "failed", "fork association must stop after birth");
  assert.equal(child.failure.stage, "dispatch");
  assert.equal((await readSoul(pathsForAkumaId(world, child.childAkumaId)))?.id, child.childAkumaId);
  assertWireRoundTrip(forkResultSchema, child);
  assert.equal(classifyVerb("fork", { akuma: parent.akumaId, at: latest.turn }, { kind: "returned", value: child }), "failed");

  const forkFailure = new Error("launcher failed after fork Soul");
  let forkedChild: typeof child.childAkumaId | undefined;
  const failedFork = akumasWithLauncher(world, async ({ paths, seed, birthSession }) => {
    assert.ok(seed && birthSession);
    const leash = await HeldAkumaLeash.try(paths);
    assert.ok(leash);
    try {
      await leash.birth(paths, { ...seed, createdAt: "2026-11-11T00:00:00.000Z" }, birthSession);
      forkedChild = seed.id;
    } finally {
      leash.release();
    }
    throw forkFailure;
  });
  await assert.rejects(failedFork.fork({ akuma: parent.akumaId, at: latest.turn }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.cause, forkFailure);
    assert.ok(forkedChild && error.message.includes(forkedChild));
    return true;
  });
  assert.ok(forkedChild);
  assert.equal((await readSoul(pathsForAkumaId(world, forkedChild)))?.id, forkedChild);
  Reflect.set(claudeProvider, "fork", originalFork);

});

test("Ask returns its own Turn answer, not an earlier retained answer", async (t) => {
  const root = temporaryDirectory(t, "exact-ask-receipt-");
  const fixture = await bornWorld(root, "feeda111");
  const { id, paths } = fixture.allocated;
  const at = "2026-11-11T00:00:00.000Z";
  const holder = (await HeldAkumaLeash.try(paths))!;
  try {
    const body = await holder.recordBody(paths, { leashTakenAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at, call: "earlier work" });
    await endTurn(paths, {
      turnSequence: turn.sequence, completedAt: at,
      outcome: { kind: "answered", answer: '{"answer":"earlier"}', session: { sessionId: "earlier" } },
    });
    assert.equal((await finishBodyIfIdle(paths, { sequence: body.sequence, at })).kind, "finished");
  } finally {
    holder.release();
  }
  const bodies: Promise<unknown>[] = [];
  t.after(() => settleFixtureBodies(bodies));
  const launcher = fixtureLauncher(bodies, new Map([[paths.directory, { adapter: answering('{"answer":"own"}'), now: at }]]));
  const result = await akumasWithLauncher(fixture.world, launcher).ask({ akuma: id, body: "own work", schema: {} });
  assert.equal(result.kind, "answered");
  assert.deepEqual(result.answer, { answer: "own" });
  const tell = await readTell(paths, result.tellId);
  assert.equal(tell?.body, "own work");
  assert.equal(tell.state, "told");
});

test("an immediate schema Ask waits for the exact invalid-output Body to retire before admission", { timeout: 10_000 }, async (t) => {
  const { world, allocated: { id, paths } } = await bornWorld(temporaryDirectory(t, "retiring-schema-ask-"), "feeda112");
  const started = deferred<void>();
  const complete = deferred<TurnResult>();
  const close = deferred<void>();
  const bodies: Promise<unknown>[] = [];
  const at = "2026-11-20T00:00:00.000Z";
  const drive = (input: DriveInput) => createProviderAttempt(input.signal, async (custody) => {
    const opening = input.launchTells[0]?.text === "invalid";
    const retire = async () => { close.resolve(); };
    custody.own({ closed: opening ? close.promise : Promise.resolve(), abort: retire, forceDispose: retire });
    if (opening) started.resolve();
    return {
      admission: { fence: opening ? "invalid" : "after" },
      events: { async *[Symbol.asyncIterator]() { yield { type: "session" as const, coordinate: { sessionId: "schema" } }; } },
      completion: opening ? complete.promise : Promise.resolve({ kind: "answered" as const, answer: '{"accepted":true}' }),
    };
  });
  const ask = akumasWithLauncher(world, fixtureLauncher(bodies, new Map([[paths.directory, {
    adapter: { ...fixtureAdapter(drive), resume: drive }, now: at,
  }]])));
  const attempts: Promise<unknown>[] = [];
  const admit = (body: string, signal = t.signal) => {
    const pending = ask.ask({ akuma: id, schema: { type: "object" }, body, signal });
    attempts.push(pending);
    void pending.catch(() => {});
    return pending;
  };
  const admission = new AsyncLocalStorage<() => void>();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "COMMIT" || sql === "ROLLBACK") admission.getStore()?.();
  });
  const begin = (body: string, signal?: AbortSignal) => {
    const judged = deferred<void>();
    const result = admission.run(judged.resolve, () => admit(body, signal));
    return { result, judged: judged.promise };
  };
  const canceled = new AbortController();
  try {
    const first = admit("invalid");
    await Promise.race([started.promise, first.then(() => assert.fail("first Ask did not open a Turn"))]);
    await assert.rejects(admit("genuinely busy"), { name: "AkumaBusyError" });
    complete.resolve({ kind: "answered", answer: "not-json" });
    const invalid = await first;
    assert.ok(invalid.kind === "invalid-output");
    const second = begin("immediate next Ask");
    let returned = false;
    void second.result.finally(() => { returned = true; }).catch(() => {});
    await second.judged;
    const heart = await readHeart(paths);
    const predecessor = heart.latestBody;
    assert.ok(predecessor && predecessor.end === undefined);
    assert.equal(await probeLeash(paths), "held");
    const tell = await readTell(paths, invalid.tellId);
    assert.ok(tell?.binding);
    const previous = await readTurn(paths, tell.binding.turnSequence);
    assert.equal(previous?.bodySequence, predecessor.sequence);
    assert.equal(previous?.end?.outcome.kind, "invalid-output");
    assert.equal(invalid.answer, "not-json");
    assert.equal(bodies.length, 1, "no second wake while the predecessor is retiring");
    const inputs = async () => (await activitySlice(paths)).rows.flatMap(row => row.kind === "tell" ? [row.body] : []);
    assert.deepEqual(await inputs(), ["invalid"], "no Tell was admitted into the retiring Body");
    assert.equal(returned, false, "retirement alone must not refuse the second Ask");

    const canceledAsk = begin("cancel before admission", canceled.signal);
    const canceledEarly = new Error("caller stopped waiting for admission");
    await canceledAsk.judged;
    canceled.abort(canceledEarly);
    await assert.rejects(canceledAsk.result, error => error === canceledEarly);
    assert.deepEqual(await inputs(), ["invalid"]);
    assert.equal(bodies.length, 1);

    close.resolve();
    const next = await second.result;
    assert.ok(next.kind === "answered");
    assert.deepEqual(next.answer, { accepted: true });
    const successorInput = await readTell(paths, next.tellId);
    assert.ok(successorInput?.binding);
    const successor = await readTurn(paths, successorInput.binding.turnSequence);
    assert.ok(successor && successor.bodySequence > predecessor.sequence);
    assert.deepEqual(await inputs(), ["invalid", "immediate next Ask"]);
    assert.equal(bodies.length, 2);
  } finally {
    canceled.abort();
    close.resolve();
    complete.resolve({ kind: "answered", answer: "not-json" });
    await Promise.allSettled(attempts);
    await settleFixtureBodies(bodies);
  }
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

  assert.ok("state" in original && original.state === "done");
  const fact = await readTell(fixture.allocated.paths, original.tellId);
  assert.ok(fact);
  const receipt = pendingTellReceipt(fact);
  const logPath = fixture.allocated.paths.log;
  const nativeFailure = Object.freeze(new TypeError("unexpected wake rejection"));
  t.mock.method(AkumaOwner.prototype, "admitTell", async () => ({ kind: "recorded", tell: fact }));
  const rejected = t.mock.method(AkumaOwner.prototype, "settleTell", async () => { throw nativeFailure; });
  await assert.rejects(api.tell({ akuma: fixture.allocated.id, body: "answer" }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError);
    assert.equal(error.cause, nativeFailure);
    assert.equal(error.tell?.tellId, original.tellId);
    return true;
  });
  rejected.mock.restore();
  t.mock.method(AkumaOwner.prototype, "settleTell", async () => ({
    ...receipt, wake: { kind: "failed", diagnostic: "historical wake failed", logPath },
  }));
  const input = { akuma: fixture.allocated.id, prompt: "answer", schema: {} };
  const told = await api.tell({ akuma: fixture.allocated.id, body: "answer", wait: true });
  assert.ok("result" in told && told.result === "failed", "Tell must keep its wake stop");
  assert.deepEqual(told.failures, [{ stage: "wake", diagnostic: "historical wake failed", logPath }]);
  assert.deepEqual(told.outcome, { turn: original.turn, at: original.at, state: "done", answer: '{"ok":true}' });
  assertWireRoundTrip(akumaTellResultSchema, told);
  assert.equal(classifyVerb("tell", input, { kind: "returned", value: told }), "failed");
  const toldText = renderVerb("tell", input, { kind: "returned", value: told }, context);
  const asked = await api.ask({ akuma: fixture.allocated.id, body: "answer", schema: {} });
  assert.ok(asked.kind === "answered", "exact answer must win");
  assert.deepEqual(asked.answer, { ok: true });
  assertWireRoundTrip(akumaAskResultSchema, asked);
  assertWireConformance(Keiyaku.verbs.ask.normal, asked);
  assert.equal(classifyVerb("ask", input, { kind: "returned", value: asked }), "accepted");
  const askText = renderVerb("ask", input, { kind: "returned", value: asked }, context);
  for (const text of [toldText, askText]) for (const evidence of [fixture.allocated.id, "historical wake failed", logPath]) assert.ok(text.includes(evidence), text);
  for (const evidence of [original.tellId, '{"ok":true}']) assert.ok(askText.includes(evidence), askText);
  const { wake: _wake, ...pure } = asked;
  assert.equal(renderVerb("ask", input, { kind: "returned", value: pure }, context), '{"ok":true}');
  const unavailable = new Error("could not observe retained delivery");
  await assert.rejects(api.tell({ akuma: fixture.allocated.id, body: "answer", wait: true,
    observe: { observe() { throw unavailable; } },
  }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError && error.cause === unavailable);
    const stopped = error.tell;
    assert.ok(stopped && "result" in stopped && stopped.result === "failed");
    assert.equal(stopped.tellId, original.tellId);
    assert.deepEqual(stopped.outcome, told.outcome);
    assert.deepEqual(stopped.failures, [...told.failures, { stage: "observation", diagnostic: unavailable.message }]);
    assertWireRoundTrip(akumaTellResultSchema, stopped);
    return true;
  });
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
