import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { Akuma, Akumas, Keis, Keiyaku, Repo, World, type InvocationWaitResult } from "../src/index.js";
import { appendActivity, beginTurn, endTurn, finishBodyIfIdle } from "../src/akuma/heart/index.js";
import { GIT_REF } from "../src/git/read-observation.js";
import { moveAlias } from "../src/alias/index.js";
import { parseAkumaAlias } from "../src/identity/selector.js";
import { classifyVerb } from "../src/library/keiyaku-verbs.js";
import { KeiyakuError } from "../src/errors.js";
import { bornBody, bornLineageAkuma } from "./support/akuma-fixtures.js";
import { withContractWaitBarrier, withContractWaitEpochs, withWaitClock } from "./support/contract-wait.js";
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
  return { repository, world, repo, environment, bound, worker, facet, finish, amend };
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

    const worker = Akuma.select(f.world, f.worker.allocated.id);
    const unrelated = await bornBody(f.world, "abcd0002", AT);
    t.after(() => unrelated.holder.release());
    await beginTurn(unrelated.allocated.paths, { bodySequence: unrelated.body.sequence, startedAt: AT });
    assert.equal((await worker.report("old report")).kind, "recorded");
    const reportInput = { selectors, completion: "all" as const };
    let reportBaseline = deferred<void>();
    let postBaseline = deferred<void>();
    let awaitPostBaseline = false;
    let postBaselineReads = 0;
    const reportMark = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
      if (sql === "SELECT sequence FROM reports ORDER BY sequence DESC LIMIT 1") reportBaseline.resolve();
      // The next round's own report read starts only after the marked round returned its
      // observation and refused to wake, so the second read is that round's completion proof.
      if (awaitPostBaseline && sql.includes(" > ? ORDER BY sequence DESC LIMIT 1") && ++postBaselineReads === 2)
        postBaseline.resolve();
      return prepare.call(this, sql);
    });
    const nextReportRound = () => {
      reportBaseline = deferred<void>();
      postBaseline = deferred<void>();
      awaitPostBaseline = false;
      postBaselineReads = 0;
    };
    // Only expire() moves the controlled clock; a wrongly woken wait ends the race below, and a
    // wait that only returned at its deadline reports elapsedMs 10_000 instead of 0.
    const openThenExpire = async (mutate?: () => Promise<unknown>) => {
      nextReportRound();
      const controller = new AbortController();
      return await withWaitClock(t, 10_000, async clock => {
        const pending = clock.within(() => facet.wait({ ...reportInput, for: "10s" }, { signal: controller.signal }));
        try {
          await Promise.race([reportBaseline.promise, pending.then(() => assert.fail("wait stopped before its report baseline"))]);
          await mutate?.();
          awaitPostBaseline = true;
          await Promise.race([postBaseline.promise, pending.then(() => assert.fail("wait stopped after its baseline instead of reaching the next round"))]);
          clock.expire();
          return await pending;
        } finally {
          controller.abort();
          await pending.catch(() => {});
        }
      });
    };
    try {
      nextReportRound();
      const head = "a new milestone\n  details ";
      let reportId: string | undefined;
      const controller = new AbortController();
      const reported = await withWaitClock(t, 10_000, async clock => {
        const pending = clock.within(() => facet.wait({ ...reportInput, for: "10s" }, { signal: controller.signal }));
        try {
          await Promise.race([reportBaseline.promise, pending.then(() => assert.fail("wait stopped before its report baseline"))]);
          const admitted = await worker.report(head + "🙂".repeat(400));
          assert.ok(admitted.kind === "recorded");
          reportId = admitted.reportId;
          return await pending;
        } finally {
          controller.abort();
          await pending.catch(() => {});
        }
      });
      assert.equal(reported.elapsedMs, 0, "the report woke the wait while its deadline stayed unexpired");
      assert.equal(reported.members[0]?.state, "waiting");
      const member = reported.members[1];
      assert.ok(member?.state === "running" && "akuma" in member);
      assert.deepEqual(member.report, {
        report: reportId,
        text: `${head}${"🙂".repeat(299 - head.length)}…`,
      });
      assert.equal(classifyVerb("wait", { ...reportInput, for: "10s" }, { kind: "returned", value: reported }), "incomplete");

      // One fresh invocation after the retained report, with an unrelated report admitted during
      // that same wait, proves both refusals together: no replayed report and no foreign wake.
      const later = await openThenExpire(async () =>
        assert.equal((await Akuma.select(f.world, unrelated.allocated.id).report("not a selected member")).kind, "recorded"));
      assert.ok(later.members.every(member => !("report" in member)),
        "the next invocation does not replay a retained report and does not wake on an unrelated report");
      assert.equal(later.elapsedMs, 10_000);
    } finally { reportMark.mock.restore(); }

    const missingInput = { selectors: ["kei/not-present", f.worker.allocated.id], for: "0ms" };
    const incomplete = await facet.wait(missingInput);
    assert.deepEqual(incomplete.members[0], { contract: "kei/not-present", state: "missing" });
    assert.equal(incomplete.members[1]?.state, "running");
    assert.equal(classifyVerb("wait", missingInput, { kind: "returned", value: incomplete }), "incomplete");

    barrier.reset();
    const second = facet.wait({ selectors, for: "10s" });
    await barrier.reads();
    await endTurn(paths, { turnSequence: turn.sequence, completedAt: AT, outcome: { kind: "answered", answer: "finished", session: { sessionId: "worker" } } });
    await f.finish();
    const completed = await second;
    const terminal = completed.members[1];
    assert.ok(terminal?.state === "done");
    assert.equal(terminal.turn, `turn/${turn.sequence}`);
    assert.equal(terminal.answer, "finished");
    assert.notEqual(completed.members[0]?.state, "changed");
    assertWireConformance(Keiyaku.verbs.wait.normal, completed);

    const failed = await facet.wait(missingInput);
    assert.equal(failed.members[0]?.state, "missing");
    assert.equal(failed.members[1]?.state, "done");
    assert.equal(classifyVerb("wait", missingInput, { kind: "returned", value: failed }), "failed");
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

test("a failed peer observation remains identified failure, not group completion", async t => {
  const f = await fixture(t);
  // One pending all-wait, driven by the real owner rounds instead of the wall deadline: the shim
  // records every journal epoch the wait itself reads, so a second mark of the same epoch proves
  // the round that produced it returned. The 30s signal only guards the fixture.
  await withContractWaitEpochs(f.world, async ({ gitPath, observed }) => {
    const input = { selectors: [f.bound.contractId, f.worker.allocated.id], completion: "all" as const, for: "1400ms" };
    const epoch = () => f.repository.run(["rev-parse", GIT_REF]).trim();
    const baseline = epoch();
    const teardown = new AbortController();
    const guard = AbortSignal.any([AbortSignal.timeout(30_000), teardown.signal]);
    const result = await withWaitClock(t, 1400, async clock => {
      const pending = clock.within(() => f.facet(gitPath).wait(input, { signal: guard }));
      try {
        await observed(baseline, pending);
        renameSync(f.worker.allocated.paths.heart, `${f.worker.allocated.paths.heart}.retained`);
        writeFileSync(f.worker.allocated.paths.heart, "not a Heart database\n");
        accepted(await f.bound.kei.abandon());
        const next = epoch();
        assert.notEqual(next, baseline, "the abandoned journal moved the epoch the wait reads");
        await observed(next, pending);
        clock.expire();
        return await pending;
      } finally {
        teardown.abort();
        await pending.catch(() => {});
      }
    });
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

test("caller cancellation retains independent owner failures and stops no work", async t => {
  const f = await fixture(t);
  const selectors = [f.bound.contractId, f.worker.allocated.id];
  const controller = new AbortController();
  const reason = new Error("caller stopped observing");
  const emit = ChildProcess.prototype.emit;
  t.mock.method(ChildProcess.prototype, "emit", function (this: ChildProcess, event: string, ...args: unknown[]) {
    const emitted = emit.call(this, event, ...args);
    if (event === "close" && args[0] === 73) controller.abort(reason);
    return emitted;
  });
  await withGitShim('if [ "$1 $2" = "cat-file --batch" ]; then echo independent Git failure >&2; exit 73; fi\nexec "$KEIYAKU_REAL_GIT" "$@"', {}, async gitPath => {
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
  t.mock.restoreAll();
  assert.equal((await Akumas.of(f.world).status({ akuma: f.worker.allocated.id })).life, "running");

  await f.finish();
  const { id, paths } = f.worker.allocated;
  const heartController = new AbortController();
  const heartReason = new Error("caller stopped at the free-leash release");
  const failure = new Error("independent native leash close failure");
  const close = DatabaseSync.prototype.close;
  let retired = 0;
  let cancel = false;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) {
    const ownLeash = this.location() === paths.leash;
    close.call(this);
    if (ownLeash) {
      retired++;
      if (cancel) heartController.abort(heartReason);
      throw failure;
    }
  });
  const input = { selectors: [f.bound.contractId, id], completion: "all" as const };
  const observed = await f.facet().wait({ ...input, for: "0ms" });
  assert.deepEqual(observed.members[1], { akuma: id, state: "unavailable", reason: failure.message });
  assert.equal(retired, 1);
  cancel = true;
  await assert.rejects(f.facet().wait(input, { signal: heartController.signal }), (error: unknown) => {
    assert.ok(error instanceof KeiyakuError && error.category === "aborted");
    assert.ok(error.cause instanceof AggregateError);
    assert.equal(error.cause.cause, heartReason);
    assert.equal(error.cause.errors.length, 2);
    assert.equal(error.cause.errors[0], heartReason);
    assert.equal(error.cause.errors[1], failure);
    assert.equal(retired, 2);
    return true;
  });
});
