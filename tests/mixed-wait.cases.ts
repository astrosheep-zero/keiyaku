import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { ChildProcess } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { Akuma, Akumas, Keis, Keiyaku, Repo, World, type InvocationWaitResult } from "../src/index.js";
import { appendActivity, beginTurn, endTurn, finishBodyIfIdle, HeldAkumaLeash, recordReport, recordTell } from "../src/akuma/heart/index.js";
import { GIT_REF, readRef } from "../src/git/read-observation.js";
import { captureLocalContractComposition } from "../src/library/contract-settings.js";
import { createKeiHandle } from "../src/library/kei.js";
import { modelJsonSchema, modelOutputSchemas } from "../src/library/model-tools.js";
import { scopeForRepo } from "../src/library/repo.js";
import { withScopeAbortSignal } from "../src/protocol/operations.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { KeiyakuError } from "../src/errors.js";
import { createKeiyakuMcpServer } from "../src/mcp/adapter.js";
import { bornBody, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { cliJson, runCli } from "./support/cli-fixtures.js";
import { withContractWaitBarrier, withContractWaitEpochs } from "./support/contract-wait.js";
import { withGitShim } from "./support/git.js";
import { accepted, document, repositoryWithMain } from "./support/library-verbs.js";
import { deferred, temporaryDirectory } from "./support/process.js";
import { assertWireConformance } from "./support/schema-parity.js";

const AT = "2026-11-16T00:00:00.000Z";
async function fixture(t: TestContext) {
  const repository = repositoryWithMain();
  const world = await World.at(repository.path);
  const home = temporaryDirectory(t, "mixed-wait-home-");
  writeFileSync(join(world, ".keiyaku", "settings.json"), JSON.stringify({ plugins: {} }));
  const environment = { HOME: home, USERPROFILE: home, KEIYAKU_HOME: home };
  const repo = await Repo.at({ path: repository.path });
  const bound = accepted(await Keis.of(repo).bind({ terms: document(), target: null, gates: ["reviewed"] }));
  const worker = await bornBody(world, "abcd0001", AT);
  t.after(() => worker.holder.release());
  const facet = (gitPath?: string) => Keiyaku.for({ cwd: world, home, environment: {
    ...environment, ...(gitPath === undefined ? {} : { KEIYAKU_GIT_PATH: gitPath }),
  } });
  const finish = async () => {
    assert.equal((await finishBodyIfIdle(worker.allocated.paths, { sequence: worker.body.sequence, at: AT })).kind, "finished");
    worker.holder.release();
  };
  const amend = async () => accepted(await bound.kei.amend({ edits: "## Replace: Objective\n\nWitness this journal change.\n" }));
  return { world, repo, environment, bound, worker, facet, finish, amend };
}

function subjects(value: InvocationWaitResult) {
  return value.members.map(member => "akuma" in member ? member.akuma : member.contract);
}

test("mixed any wakes from either native owner; all retains its original Contract baseline", async t => {
  const f = await fixture(t);
  const selectors = [f.bound.contractId, f.worker.allocated.id];
  await withContractWaitBarrier(f.world, async barrier => {
    const facet = f.facet(barrier.gitPath);
    const paths = f.worker.allocated.paths;
    const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
    const sequence = await appendActivity(paths, { turnSequence: turn.sequence, at: AT, event: { type: "assistant", text: "working" } });
    const tail = (await Akuma.select(f.world, f.worker.allocated.id).status()).recent;
    const witnessed = deferred<void>();
    const prepare = DatabaseSync.prototype.prepare;
    const mark = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      // A post-baseline probe proves the first coherent Akuma observation returned.
      if (sql.includes("FROM reports WHERE sequence > ? ORDER BY sequence DESC LIMIT 1")) witnessed.resolve();
      return prepare.call(this, sql);
    });
    try {
      const first = facet.wait({ selectors, for: "10s" });
      await Promise.race([
        Promise.all([barrier.reads(), witnessed.promise]),
        first.then(() => assert.fail("mixed wait stopped before both native observations")),
      ]);
      await f.amend();
      const changed = await first;
      assert.deepEqual(subjects(changed), selectors);
      const contract = changed.members[0];
      assert.ok(contract && "contract" in contract);
      assert.equal(contract.state, "changed");
      assert.equal(contract.title, "Library verbs");
      assert.equal(contract.phase, "bound");
      assert.deepEqual(contract.gates, [{ gate: "reviewed", current: "missing" }]);
      const worker = changed.members[1];
      assert.ok(worker?.state === "running");
      assert.equal(worker.turn, `turn/${turn.sequence}`);
      assert.ok(Array.isArray(worker.events));
      assert.equal(worker.events.at(-1)?.id, sequence);
      assert.deepEqual(worker.events, tail);
    } finally { mark.mock.restore(); }
    await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "canceled" } });

    const next = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
    const nextEvent = await appendActivity(paths, { turnSequence: next.sequence, at: AT, event: { type: "assistant", text: "second Turn" } });
    const deadline = await withContractWaitEpochs(f.world, async ({ gitPath, observed }) => {
      const controller = new AbortController();
      const { signal } = controller;
      const scope = withScopeAbortSignal(scopeForRepo(f.repo), signal);
      const writer = createKeiHandle(f.bound.contractId, scope, captureLocalContractComposition());
      const epoch = async () => {
        const snapshot = await readRef(scope, GIT_REF);
        assert.ok(snapshot);
        return snapshot;
      };
      const watchdogMs = 60_000;
      const timeoutMs = 120_000; // Safety envelope only; the fixture has its own real watchdog.
      const watchdog = setTimeout(() => controller.abort(new Error("mixed ALL fixture watchdog expired")), watchdogMs);
      const nativeWait = new AsyncLocalStorage<boolean>();
      let expire: (() => void) | undefined;
      let expired = false;
      const readsAfterExpiry: string[] = [];
      const queries = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
        if (expired && nativeWait.getStore() && /FROM bodies ORDER BY sequence DESC LIMIT 1|ORDER BY sequence DESC LIMIT 3/u.test(sql)) {
          readsAfterExpiry.push(sql);
        }
        return prepare.call(this, sql);
      });
      const realTimeout = setTimeout;
      const timer = t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        // Only the scoped invocation's deadline outlasts the fixture watchdog.
        if (nativeWait.getStore() && ms !== undefined && ms > watchdogMs && ms <= timeoutMs) {
          expire = callback;
          timer.mock.restore();
        }
        return realTimeout(callback, ms, ...args);
      });
      let all: Promise<InvocationWaitResult> | undefined;
      try {
        const baseline = await epoch();
        all = nativeWait.run(true, () => f.facet(gitPath).run("wait", {
          selectors, completion: "all", for: `${timeoutMs}ms`,
        }, { signal }));
        await observed(baseline, all);
        accepted(await writer.arc({ body: "# Still waiting\n\nThis is a new journal fact.\n" }));
        await observed(await epoch(), all);
        assert.ok(expire, "native wait armed its deadline");
        const expiredAt = performance.now() + timeoutMs;
        const clock = t.mock.method(performance, "now", () => expiredAt, { times: 1 });
        expired = true;
        try { expire(); } finally { clock.mock.restore(); }
        assert.equal(clock.mock.calls.length, 1, "fixture fired the observation clock");
        const result = await all;
        assert.deepEqual(readsAfterExpiry, [], "expiry does not reacquire Heart lifecycle or the current Turn tail");
        return result;
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      } finally {
        clearTimeout(watchdog);
        timer.mock.restore();
        controller.abort();
        await all?.catch(() => {});
        queries.mock.restore();
      }
    });
    assert.deepEqual(subjects(deadline), selectors);
    assert.equal(deadline.members[0]?.state, "changed");
    const advanced = deadline.members[1];
    assert.ok(advanced?.state === "running");
    assert.equal(advanced.turn, `turn/${next.sequence}`);
    assert.deepEqual(advanced.last, { turn: `turn/${turn.sequence}`, state: "canceled", at: AT });
    assert.ok(Array.isArray(advanced.events));
    assert.equal(advanced.events.at(-1)?.id, nextEvent);
    assertWireConformance(Keiyaku.verbs.wait.normal, deadline);

    barrier.reset();
    const second = facet.wait({ selectors, for: "10s" });
    await barrier.reads();
    await endTurn(paths, { turnSequence: next.sequence, completedAt: AT, outcome: { kind: "answered", answer: "finished", session: { sessionId: "worker" } } });
    await f.finish();
    const completed = await second;
    const terminal = completed.members[1];
    assert.ok(terminal?.state === "done");
    assert.equal(terminal.turn, `turn/${next.sequence}`);
    assert.equal(terminal.answer, "finished");
    assert.notEqual(completed.members[0]?.state, "changed");
  });
});

test("mixed all waits for both members, freezing aliases/globs and first-seen order", async t => {
  const f = await fixture(t);
  await moveAlias({ world: f.world, alias: parseAkumaAlias("@worker"), akumaId: f.worker.allocated.id });
  await withContractWaitBarrier(f.world, async barrier => {
    const pending = f.facet(barrier.gitPath).wait({
      selectors: ["@worker", f.bound.contractId, "aku/claude/*", f.bound.contractId], completion: "all", for: "10s",
    });
    await barrier.reads();
    const peer = await bornLineageAkuma({ root: f.world, akumaName: "claude", draw: "abcd0002", createdAt: AT });
    await moveAlias({ world: f.world, alias: parseAkumaAlias("@worker"), akumaId: peer.id });
    await f.amend();
    barrier.reset();
    await barrier.reads(2);
    await f.finish();
    const result = await pending;
    assert.deepEqual(subjects(result), [f.worker.allocated.id, f.bound.contractId]);
    assert.deepEqual(result.members.map(({ state }) => state), ["idle", "changed"]);
    assertWireConformance(Keiyaku.verbs.wait.normal, result);
  });
});

test("mixed all returns new selected progress without completing or replaying it", async t => {
  const f = await fixture(t);
  const worker = Akuma.select(f.world, f.worker.allocated.id);
  const unrelated = await bornBody(f.world, "abcd0002", AT);
  t.after(() => unrelated.holder.release());
  await beginTurn(unrelated.allocated.paths, { bodySequence: unrelated.body.sequence, startedAt: AT });
  const paths = f.worker.allocated.paths;
  const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  assert.equal((await worker.report("old report")).kind, "recorded");
  const input = { selectors: [f.bound.contractId, worker.id], completion: "all" as const };
  let baseline = deferred<void>();
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (sql === "SELECT sequence FROM reports ORDER BY sequence DESC LIMIT 1") baseline.resolve();
    return prepare.call(this, sql);
  });
  const started = (pending: Promise<unknown>) => Promise.race([
    baseline.promise,
    pending.then(() => assert.fail("wait stopped before capturing the report baseline")),
  ]);

  const old = f.facet().wait({ ...input, for: "1200ms" });
  await started(old);
  const other = await Akuma.select(f.world, unrelated.allocated.id).report("not a selected member");
  assert.equal(other.kind, "recorded");
  assert.ok((await old).members.every(member => !("report" in member)));

  baseline = deferred<void>();
  await withContractWaitBarrier(f.world, async barrier => {
    const pending = cliJson<InvocationWaitResult>(["wait", ...input.selectors, "--all", "--for", "10s"], {
      cwd: f.world, environment: { ...f.environment, KEIYAKU_GIT_PATH: barrier.gitPath },
    });
    await started(pending);
    await barrier.reads();
    const sequences = [];
    for (const text of ["later first", "later second"])
      sequences.push(await appendActivity(paths, { turnSequence: turn.sequence, at: AT, event: { type: "assistant", text } }));
    const head = "a new milestone\n  details ";
    const recorded = await worker.report(head + "🙂".repeat(400));
    assert.ok(recorded.kind === "recorded");
    const { exit, value } = await pending;
    assert.equal(exit, 75);
    assert.deepEqual(subjects(value), input.selectors);
    assert.equal(value.members[0]?.state, "waiting");
    const member = value.members[1];
    assert.ok(member?.state === "running");
    assert.deepEqual(member.report, {
      report: recorded.reportId,
      text: `${head}${"🙂".repeat(299 - head.length)}…`,
    });
    assert.ok(Array.isArray(member.events));
    assert.deepEqual(member.events.map(({ id }) => id), [
      ...sequences, Number(recorded.reportId.slice("report/".length)),
    ]);
    assert.deepEqual(member.events, (await worker.status()).recent);
    assertWireConformance(Keiyaku.verbs.wait.normal, value);
    const validate = new AjvJsonSchemaValidator().getValidator(JSON.parse(JSON.stringify(modelJsonSchema(modelOutputSchemas.wait))));
    assert.equal(validate(value).valid, true, "the published schema accepts the non-leading reporter");
    const invalid = { ...value, members: [{ ...value.members[0], report: member.report }, member] };
    assert.equal(Keiyaku.verbs.wait.output.safeParse(invalid).success, false);
    assert.equal(Keiyaku.verbs.wait.normal.safeParse(invalid).success, false);
    assert.equal(validate(invalid).valid, false);
  });

  const later = await f.facet().wait({ ...input, for: "600ms" });
  assert.deepEqual(later.members.map(({ state }) => state), ["waiting", "running"]);
  assert.ok(later.members.every(member => !("report" in member)), "the next invocation does not replay a retained report");
});

test("already satisfied members count immediately and slow peers stay honestly unknown", async t => {
  const f = await fixture(t);
  await f.finish();
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
    const started = performance.now();
    const result = await f.facet(gitPath).wait({ selectors: [f.bound.contractId, f.worker.allocated.id], for: "10s" });
    assert.ok(performance.now() - started < 5000, "any does not spend a peer's full bound");
    assert.deepEqual(result.members[0], { contract: f.bound.contractId, state: "unavailable" });
    assert.equal(result.members[1]?.state, "idle");
    assertWireConformance(Keiyaku.verbs.wait.output, result);
    assertWireConformance(Keiyaku.verbs.wait.normal, result, false);
  });
  accepted(await f.bound.kei.abandon());
  const result = await f.facet().wait({ selectors: [f.bound.contractId, f.worker.allocated.id], completion: "all", for: "0ms" });
  assert.deepEqual(result.members.map(({ state }) => state), ["abandoned", "idle"], "zero still observes finished work");
  assertWireConformance(Keiyaku.verbs.wait.normal, result);
});

test("caller cancellation cannot erase an independently failed native Contract read", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("caller stopped observing");
  const emit = ChildProcess.prototype.emit;
  t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: unknown[]) {
    const emitted = emit.call(this, event, ...args);
    if (event === "close" && args[0] === 73) controller.abort(reason);
    return emitted;
  });
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then echo independent Git failure >&2; exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
    const selectors = [f.bound.contractId, f.worker.allocated.id];
    await assert.rejects(f.facet(gitPath).wait({ selectors, completion: "all" }, { signal: controller.signal }), (error: unknown) => {
      assert.ok(error instanceof KeiyakuError && error.category === "aborted");
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.cause, reason);
      assert.equal(error.cause.errors[0], reason);
      assert.equal(error.cause.errors.length, 2);
      assert.match(error.cause.errors[1].message, /independent Git failure/u);
      return true;
    });
  });
});

test("caller cancellation also retains an independent Heart observation retirement failure", async t => {
  const f = await fixture(t);
  await f.finish();
  const { id, paths } = f.worker.allocated;
  const controller = new AbortController();
  const reason = new Error("caller stopped at the free-leash release");
  const failure = new Error("independent native leash close failure");
  const close = DatabaseSync.prototype.close;
  let retired = 0;
  let cancel = false;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    const ownLeash = this.location() === paths.leash;
    close.call(this);
    if (ownLeash) {
      retired++;
      if (cancel) controller.abort(reason);
      throw failure;
    }
  });
  const input = { selectors: [f.bound.contractId, id], completion: "all" as const };
  const observed = await f.facet().wait({ ...input, for: "0ms" });
  assert.deepEqual(observed.members[1], { akuma: id, state: "unavailable", reason: failure.message });
  assert.equal(retired, 1);
  cancel = true;
  await assert.rejects(f.facet().wait(input, { signal: controller.signal }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError && error.category === "aborted");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.cause, reason);
    assert.equal(error.cause.errors.length, 2);
    assert.equal(error.cause.errors[0], reason);
    assert.equal(error.cause.errors[1], failure);
    assert.equal(retired, 2);
    return true;
  });
});

test("expiry during free-leash recheck keeps the identity-proved report, activity time and retained outcome", async t => {
  const f = await fixture(t);
  const peer = await beginTurn(f.worker.allocated.paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  const reporter = await bornBody(f.world, "abcd0002", AT);
  t.after(() => reporter.holder.release());
  const { paths, id } = reporter.allocated;
  const turn = await beginTurn(paths, { bodySequence: reporter.body.sequence, startedAt: AT });
  const reportedAt = "2026-11-16T00:00:01.000Z";
  const completedAt = "2026-11-16T00:00:02.000Z";
  const text = "report from the first committed read";
  const answer = "retained before expiry";
  let reportId: `report/${number}` | undefined;
  const now = performance.now.bind(performance);
  let expired = false;
  let afterExpiry = 0;
  const duration = 10_000;
  const sql = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, ...args: Parameters<typeof sql>) {
    if (expired) afterExpiry++;
    return sql.apply(this, args);
  });
  t.mock.method(performance, "now", () => now() + (expired ? duration : 0));
  const acquire = HeldAkumaLeash.try;
  t.mock.method(HeldAkumaLeash, "try", async (selected: typeof paths) => {
    const claim = await acquire.call(HeldAkumaLeash, selected);
    if (selected.heart === paths.heart) {
      if (reportId === undefined) {
        assert.equal(claim, null, "the initial report frontier was read while the reporter held its leash");
        const recorded = await recordReport(paths, { text, at: reportedAt });
        assert.ok(recorded.kind === "recorded");
        reportId = `report/${recorded.report.sequence}`;
        await endTurn(paths, { turnSequence: turn.sequence, completedAt, outcome: { kind: "answered", answer, session: { sessionId: "worker" } } });
        assert.equal((await finishBodyIfIdle(paths, { sequence: reporter.body.sequence, at: completedAt })).kind, "finished");
        reporter.holder.release();
      } else {
        assert.ok(claim, "fixture reaches the actual free-leash boundary after the report read");
        expired = true;
      }
    }
    return claim;
  });
  const result = await f.facet().wait({ selectors: [f.worker.allocated.id, id], completion: "all", for: "10s" });
  assert.ok(reportId && expired);
  assert.equal(afterExpiry, 0);
  const [running, unavailable] = result.members;
  assert.ok(running?.state === "running" && "akuma" in running);
  assert.equal(running.turn, `turn/${peer.sequence}`);
  assert.deepEqual(unavailable, {
    akuma: id,
    state: "unavailable",
    report: { report: reportId, text },
    lastActivityAt: reportedAt,
    last: { turn: `turn/${turn.sequence}`, state: "done", at: completedAt, answer },
  });
  assertWireConformance(Keiyaku.verbs.wait.normal, result);
});

test("all-mode CLI omits a resume that would drop an unavailable Contract", async t => {
  const f = await fixture(t);
  const { id } = f.worker.allocated;
  const baseline = deferred<void>();
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql === "SELECT sequence FROM reports ORDER BY sequence DESC LIMIT 1") baseline.resolve();
    return prepare.call(this, sql);
  });
  let expire: (() => void) | undefined;
  const realTimeout = setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined && ms > 9000 && ms <= 10_000) expire = callback;
    return realTimeout(callback, ms, ...args);
  });
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
    const pending = runCli(["wait", f.bound.contractId, id, "--all", "--for", "10s"], {
      cwd: f.world, environment: { ...f.environment, KEIYAKU_GIT_PATH: gitPath },
    });
    await Promise.race([baseline.promise, pending.then(() => assert.fail("Wait did not issue its Akuma read"))]);
    assert.ok(expire, "the observation armed its clock");
    const expiredAt = performance.now() + 10_000;
    const clock = t.mock.method(performance, "now", () => expiredAt, { times: 1 });
    try { expire(); } finally { clock.mock.restore(); }
    const result = await pending;
    assert.equal(result.exit, 75);
    assert.ok(result.stdout.includes(`${f.bound.contractId}  unavailable`));
    assert.ok(result.stdout.includes(`${id}  running`));
    assert.doesNotMatch(result.stdout, /^resume:/mu);
  });
});

test("one deadline and caller abort release readers without stopping Akuma work", async t => {
  const f = await fixture(t);
  const selectors = [f.bound.contractId, f.worker.allocated.id];
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then exec sleep 30; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
    const started = performance.now();
    const result = await f.facet(gitPath).wait({ selectors, completion: "all", for: "200ms" });
    assert.ok(performance.now() - started < 5000);
    assert.deepEqual(result.members[0], { contract: f.bound.contractId, state: "unavailable" });
  });
  await withContractWaitBarrier(f.world, async barrier => {
    const controller = new AbortController();
    const reason = new Error("caller stops watching");
    const pending = f.facet(barrier.gitPath).wait({ selectors, completion: "all" }, { signal: controller.signal });
    await barrier.reads(2);
    const original = DatabaseSync.prototype.close;
    let closes = 0;
    t.mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) { closes++; return original.call(this); });
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.ok(closes > 0, "cancellation retires the retained Heart reader before rejecting");
    t.mock.restoreAll();
  });
  const worker = await Akumas.of(f.world).status({ akuma: f.worker.allocated.id });
  assert.equal(worker.life, "running");
});

test("mixed missing authority retains native refusal, never satisfying any", async t => {
  const f = await fixture(t);
  const input = { selectors: ["kei/not-present", f.worker.allocated.id], for: "0ms" };
  const result = await f.facet().wait(input);
  assert.deepEqual(result.members[0], { contract: "kei/not-present", state: "missing" });
  assert.equal(classifyVerb("wait", input, { kind: "returned", value: result }), "incomplete");
  assertWireConformance(Keiyaku.verbs.wait.normal, result);
  await f.finish();
  const failure = await cliJson<InvocationWaitResult>(["wait", ...input.selectors, "--for", "0ms"], { cwd: f.world, environment: f.environment });
  assert.equal(failure.exit, 1);
  assert.deepEqual(failure.value.members.map(({ state }) => state), ["missing", "idle"]);
  assertWireConformance(Keiyaku.verbs.wait.output, failure.value);
  assertWireConformance(Keiyaku.verbs.wait.normal, failure.value, false);
});

test("unsettled Akumas repeatedly select a bounded current Turn without acquiring full status", async t => {
  const f = await fixture(t);
  const turn = await beginTurn(f.worker.allocated.paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  for (const selectors of [[f.worker.allocated.id], [f.bound.contractId, f.worker.allocated.id]]) {
    let fullFrontiers = 0;
    let tails = 0;
    const prepare = DatabaseSync.prototype.prepare;
    const queries = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (sql.includes("SELECT sequence FROM turns ORDER BY sequence DESC LIMIT 1")) fullFrontiers++;
      if (sql.includes("ORDER BY sequence DESC LIMIT 3")) tails++;
      return prepare.call(this, sql);
    });
    try {
      const result = await f.facet().wait({ selectors, completion: "all", for: "1200ms" });
      const worker = result.members.find(member => "akuma" in member);
      assert.ok(worker?.state === "running");
      assert.equal(worker.turn, `turn/${turn.sequence}`);
      assert.ok(tails > 1, "intervening rounds still probe native completion and its current work");
      assert.equal(fullFrontiers, 0);
    } finally { queries.mock.restore(); }
  }
});

test("a failed peer observation remains identified failure, not group completion", async t => {
  const f = await fixture(t);
  await withContractWaitBarrier(f.world, async barrier => {
    const input = { selectors: [f.bound.contractId, f.worker.allocated.id], completion: "all" as const, for: "1400ms" };
    const pending = f.facet(barrier.gitPath).wait(input);
    await barrier.reads(2);
    renameSync(f.worker.allocated.paths.heart, `${f.worker.allocated.paths.heart}.retained`);
    writeFileSync(f.worker.allocated.paths.heart, "not a Heart database\n");
    accepted(await f.bound.kei.abandon());
    const result = await pending;
    assert.equal(result.members[0]?.state, "abandoned");
    const peer = result.members[1];
    assert.ok(peer?.state === "unavailable" && "akuma" in peer);
    assert.equal(peer.akuma, f.worker.allocated.id);
    assert.match(peer.reason ?? "", /not a database/u);
    assert.equal(classifyVerb("wait", input, { kind: "returned", value: result }), "failed");
    assertWireConformance(Keiyaku.verbs.wait.output, result);
    assertWireConformance(Keiyaku.verbs.wait.normal, result, false);
  });
});

test("bounded wait returns three actual events and settled wait keeps the complete exact-Turn answer", async t => {
  const f = await fixture(t);
  const paths = f.worker.allocated.paths;
  const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  await appendActivity(paths, { turnSequence: turn.sequence, at: AT, event: {
    type: "tool", id: "edit", name: "edit", phase: "completed", result: { status: "ok" },
    call: { kind: "fileChange", changes: [{ op: "update", path: "source.ts", diffstat: { added: 2, removed: 1 } }] },
  } });
  const adapter = createKeiyakuMcpServer({ cwd: f.world, environment: f.environment, version: "test" });
  const client = new Client({ name: "full-wait-and-changes", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), adapter.server.connect(b)]);
  t.after(async () => { await client.close(); await adapter.close(); });
  await client.listTools();
  const sequences = [];
  for (const text of ["first", "second", "same", "same", "last"]) {
    sequences.push(await appendActivity(paths, { turnSequence: turn.sequence, event: { type: "assistant", text }, at: AT }));
  }
  const input = { selectors: [f.worker.allocated.id, f.bound.contractId], completion: "all" as const, for: "0ms" };
  const running = await f.facet().wait(input);
  const argv = ["wait", ...input.selectors, "--all", "--for", "0ms"];
  const cli = await cliJson<InvocationWaitResult>(argv, { cwd: f.world, environment: f.environment });
  assert.equal(cli.exit, 75);
  assert.deepEqual(cli.value, running);
  const member = running.members[0];
  assert.ok(member?.state === "running");
  assert.equal(member.lastActivityAt, AT);
  assert.ok(Array.isArray(member.events));
  assert.deepEqual(member.events.map(event => event.id), sequences.slice(-3));
  const status = await Akuma.select(f.world, f.worker.allocated.id).status();
  assert.deepEqual(status.work.outcome, { turn: `turn/${turn.sequence}`, state: "running" });
  assert.deepEqual(member.events, status.recent);
  assert.match(member.events.at(-1)?.text ?? "", /▎ \d+\n +last$/u);
  const text = await runCli(argv, { cwd: f.world, environment: f.environment });
  assert.equal(text.exit, 75);
  assert.equal((text.stdout.match(/same/gu) ?? []).length, 2);
  assert.ok(text.stdout.indexOf(f.worker.allocated.id) < text.stdout.indexOf(f.bound.contractId));
  const deadlineResponse = await client.callTool({ name: "wait", arguments: input });
  assert.equal(deadlineResponse.isError, false);
  assert.deepEqual(deadlineResponse.structuredContent, JSON.parse(JSON.stringify(running)));
  const transportText = (deadlineResponse.content as { text: string }[])[0]?.text;
  assert.ok(transportText);
  assert.equal(transportText.split("\nresume:")[0], text.stdout.split("\nresume:")[0]);
  const resume = text.stdout.split("\n").find(line => line.startsWith("resume: "));
  assert.ok(resume?.endsWith(`${input.selectors.join(" ")} --all --for 0ms`));
  assert.doesNotMatch(text.stdout, /delivery absent/u, "thin gate evidence makes no claim about delivery");

  const answer = `answer begins\n${"full answer ".repeat(1000)}\n  exact answer tail`;
  await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "answered", answer, session: { sessionId: "answer" } } });
  const betweenTurns = (await f.facet().wait(input)).members[0];
  assert.ok(betweenTurns?.state === "running");
  assert.equal(betweenTurns.turn, undefined);
  assert.deepEqual(betweenTurns.events, [], "a running Body between Turns has no current-Turn tail");
  await f.finish();
  accepted(await f.bound.kei.abandon());
  const settled = await f.facet().wait(input);
  const response = await client.callTool({ name: "wait", arguments: input });
  assert.equal(response.isError, false);
  assert.deepEqual(response.structuredContent, JSON.parse(JSON.stringify(settled)));
  const projected = modelOutputSchemas.wait.parse(response.structuredContent);
  const row = projected.members[0];
  const exact = { turn: `turn/${turn.sequence}`, at: AT, state: "done", answer };
  assert.deepEqual(row, { akuma: f.worker.allocated.id, lastActivityAt: AT, ...exact });
  const worker = Akuma.select(f.world, f.worker.allocated.id);
  assert.deepEqual((await worker.status()).work.outcome, exact);
  assert.deepEqual(await Akumas.of(f.world).history({ akuma: worker.id, id: exact.turn }), {
    kind: "akuma-exact", akumaId: worker.id, outcome: exact,
  });
  const completedText = await runCli(["wait", f.worker.allocated.id, "--for", "0ms"], { cwd: f.world, environment: f.environment });
  assert.equal(completedText.exit, 0);
  assert.match(completedText.stdout, new RegExp(`turn/${turn.sequence}`, "u"));
  assert.ok(completedText.stdout.includes("exact answer tail"));
  assert.equal((completedText.stdout.match(/full answer/gu) ?? []).length, 1000);
});

test("a corrupt eligible running tail preserves the older exact outcome and readable Contract", async t => {
  const f = await fixture(t);
  const paths = f.worker.allocated.paths;
  const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "failed", diagnostic: "exact failure" } });
  const next = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  const corrupt = await appendActivity(paths, { turnSequence: next.sequence, event: { type: "assistant", text: "activity" }, at: AT });
  const database = new DatabaseSync(paths.heart);
  try { assert.equal(database.prepare("UPDATE activity SET event_json = ? WHERE sequence = ?").run("{}", corrupt).changes, 1); }
  finally { database.close(); }
  const result = await f.facet().wait({ selectors: [f.worker.allocated.id, f.bound.contractId], completion: "all", for: "0ms" });
  const member = result.members[0];
  assert.ok(member?.state === "running");
  assert.equal(member.turn, `turn/${next.sequence}`);
  assert.deepEqual(member.last, { turn: `turn/${turn.sequence}`, at: AT, state: "failed", reason: "exact failure" });
  assert.ok(member.events && "reason" in member.events);
  assert.match(member.events.reason, /Invalid/u);
  const peer = result.members[1];
  assert.ok(peer && "contract" in peer);
  assert.equal(peer.contract, f.bound.contractId);
  assert.equal(peer.phase, "bound");
  assertWireConformance(Keiyaku.verbs.wait.normal, result);
});

test("an asleep Akuma with pending Tell is incomplete without claiming a Turn or tail", async t => {
  const f = await fixture(t);
  const paths = f.worker.allocated.paths;
  const turn = await beginTurn(paths, { bodySequence: f.worker.body.sequence, startedAt: AT });
  await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "answered", answer: "", session: { sessionId: "worker" } } });
  await f.finish();
  const admitted = await recordTell(paths, { kind: "tell", id: "pending", body: "new input", recordedAt: AT });
  assert.equal(admitted.kind, "recorded");
  const { exit, value } = await cliJson<InvocationWaitResult>(["wait", f.worker.allocated.id, "--for", "0ms"], {
    cwd: f.world, environment: f.environment,
  });
  assert.equal(exit, 75);
  assert.deepEqual(value.members, [{
    akuma: f.worker.allocated.id, state: "waiting", lastActivityAt: AT,
    last: { turn: `turn/${turn.sequence}`, at: AT, state: "done", answer: "" },
  }]);
});
