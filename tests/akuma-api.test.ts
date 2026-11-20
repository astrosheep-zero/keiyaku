import { noBodyLaunch } from "./support/akuma-fixtures.js";
import { fixtureAdapter } from "./support/akuma-tell.js";
import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Akuma } from "../src/akuma/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { type TellWakeRuntime } from "../src/akuma/body.js";
import {
  beginTurn,
  bindTellsToTurn,
  cancelBodyTurns,
  finishBodyIfIdle,
  HeldAkumaLeash,
  readHeart,
  readTell,
  readTurn,
  recordTell,
  recordTellDeliveries,
  recordTellReceipt,
} from "../src/akuma/heart/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { createLiveStatusReader } from "../src/akuma/akuma-observe.js";
import { executeWaitAkuma, createAkumaWaitObserver } from "../src/akuma/akuma-wait.js";
import { DatabaseSync } from "node:sqlite";
import { insertActivityFact } from "../src/akuma/heart/rows.js";
import { createProviderAttempt, type ProviderAdapter } from "../src/akuma/provider.js";
import { executeAskAkuma, executeTellAkuma } from "../src/akuma/akuma-selection-execution.js";
import { KeiyakuError } from "../src/index.js";
import {
  deferred,
  installAkumaBodyPidReceipt,
  waitForCondition,
  waitForPidReceiptExit,
} from "./support/process.js";
import { canonicalDocument } from "../src/akuma/schema.js";
import { World } from "../src/world.js";
import { debtAuthorityFile } from "./support/debt.js";
import { isolateUserHome } from "./support/user-home.js";

isolateUserHome();

test("Akuma.birth has no prompt and select is synchronous", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-birth-");
  const bodyPidReceipt = join(root, "body-pids");
  const restoreBodyPidReceipt = installAkumaBodyPidReceipt(bodyPidReceipt);
  try {
    const home = join(root, "home");
    mkdirSync(join(home, "akumas"), { recursive: true });
    writeFileSync(join(home, "akumas", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
    const world = await World.at(root);
    const born = await Akuma.birth("worker", { root: world, home, cwd: root });
    const selected = Akuma.select(world, born.id);
    assert.equal(selected.id, born.id);
    assert.equal((await selected.status()).id, born.id);
    await born.idle();
    const page = await born.history();
    assert.equal(Array.isArray(page.rows), true);
    await born.kill();
    // The cooperative stop settles Heart and releases the leash before the real
    // provider Body process finishes departing; the temp tree must outlive that
    // retirement, so wait for the recorded Body pid to exit before teardown.
    await waitForPidReceiptExit(bodyPidReceipt, 15_000, { requireBirth: true });
  } finally {
    restoreBodyPidReceipt();
  }
});

test("standalone Akuma operations never read optional Alias or Debt authority", async () => {
  await withWaitedTellFixture(async ({ born }) => {
    const value = await born("51a1e001", answering("standalone answer"));
    // Corrupt every optional cross-product authority a standalone operation must never touch.
    mkdirSync(join(value.world, ".keiyaku", "akuma"), { recursive: true });
    writeFileSync(join(value.world, ".keiyaku", "akuma", "alias.json"), "not json\n");
    const brokenDebt = debtAuthorityFile(value.world, "debt/corrupt-authority");
    mkdirSync(join(value.world, ".keiyaku", "debts"), { recursive: true });
    writeFileSync(brokenDebt, "not a debt document\n");
    const selected = akumaWithLauncher(value.world, value.allocated.id, value.spawn);
    assert.equal((await selected.status()).id, value.allocated.id);
    assert.equal(Array.isArray((await selected.history()).rows), true);
    assert.equal((await selected.idle({ timeoutMs: 0 })).status.akuma, value.allocated.id);
    const asked = await selected.tell("standalone", { wait: true, timeoutMs: 5_000 });
    assert.ok("state" in asked && asked.state === "done");
    assert.equal(asked.answer, "standalone answer");
    assert.ok(["killed", "already-stopped", "already-killed"].includes(await selected.kill()));
  });
});

import { answering, bornWorld, fixtureLauncher, settleFixtureBodies } from "./support/akuma-tell.js";
import { akumaWithLauncher } from "../src/akuma/akuma-instance.js";
import type { BodyLauncher } from "../src/akuma/body-launch.js";

const WAITED_TELL_NOW = "2026-08-10T00:00:01.000Z";
type WaitedTellWorld = Awaited<ReturnType<typeof bornWorld>> & { spawn: BodyLauncher };
type WaitedTellFixture = {
  root: string;
  born(suffix: string, adapter: ProviderAdapter, now?: string): Promise<WaitedTellWorld>;
  settle(): Promise<void>;
};
type WaitedTellOptions = Omit<Parameters<typeof executeAskAkuma>[0], "path" | "id" | "spawn">;

function waitTell(world: WaitedTellWorld, options: WaitedTellOptions) {
  return executeAskAkuma({ spawn: world.spawn, path: world.world, id: world.allocated.id, ...options });
}

async function withWaitedTellFixture<T>(run: (fixture: WaitedTellFixture) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-ask-"));
  const bodies: Promise<unknown>[] = [];
  const adapters = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const spawn = fixtureLauncher(bodies, adapters);
  const settle = () => settleFixtureBodies(bodies);
  const born = async (suffix: string, adapter: ProviderAdapter, now = WAITED_TELL_NOW) => {
    const fixture = await bornWorld(root, suffix, spawn);
    adapters.set(fixture.allocated.paths.directory, { adapter, now });
    return { ...fixture, spawn };
  };
  try {
    return await run({
      root,
      born,
      settle,
    });
  } finally {
    await settle();
    rmSync(root, { recursive: true, force: true });
  }
}

function gatedAnswer(gate: Promise<string>, started?: () => void): ProviderAdapter {
  return fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
    custody.own({ closed: gate.then(() => undefined), forceDispose: async () => {} });
    return {
      admission: { fence: "waited-fixture" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "waited-fixture" } };
          started?.();
        },
      },
      completion: gate.then((answer) => ({ kind: "answered" as const, answer, historyId: "waited-fixture" })),
    };
  }));
}

test("waited Tell cancellation preserves exact admission", async () => {
  await withWaitedTellFixture(async ({ born, settle }) => {
    const observe = ({ allocated, spawn, world }: WaitedTellWorld, options: WaitedTellOptions) =>
      executeTellAkuma({ ...options, spawn, path: world, id: allocated.id, wait: true });
    const started = deferred<void>();
    const finish = deferred<string>();
    const canceled = await born("a1000015", gatedAnswer(finish.promise, started.resolve));
    const controller = new AbortController();
    const reason = Object.freeze(new Error("stop observing the admitted Tell"));
    const tellId = "waited-cancel-tell";
    const pending = observe(canceled, { body: "finish later", tellId, timeoutMs: 5_000, signal: controller.signal });
    try {
      await Promise.race([
        started.promise,
        pending.then(() => assert.fail("Waited Tell returned before the provider started")),
      ]);
      await waitForCondition(
        "the admitted Tell to bind its Turn",
        async () => (await readTell(canceled.allocated.paths, tellId))?.binding !== undefined,
      );
      controller.abort(reason);
      await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof KeiyakuError);
        assert.equal(error.cause, reason);
        assert.equal(error.category, "aborted");
        assert.equal(error.tell?.tellId, tellId);
        assert.equal(error.tell?.akumaId, canceled.allocated.id);
        assert.ok(Object.isFrozen(error.tell));
        assert.ok(error.tell && "result" in error.tell && error.tell.result === "failed");
        assert.ok(Object.isFrozen(error.tell.failures));
        assert.deepEqual(error.tell.failures, [{ stage: "observation", diagnostic: reason.message }]);
        assert.throws(() => Object.assign(error, { tell: undefined }), TypeError);
        return true;
      });
      const admitted = await readTell(canceled.allocated.paths, tellId);
      assert.equal(admitted?.body, "finish later");
      assert.notEqual(admitted?.binding, undefined, "cancellation does not retract the admitted Tell");
    } finally {
      finish.resolve("late answer");
    }
    await settle();
    const settled = await readTell(canceled.allocated.paths, tellId);
    assert.equal(settled?.state, "told");
    const turn =
      settled?.binding === undefined ? null : await readTurn(canceled.allocated.paths, settled.binding.turnSequence);
    assert.equal(turn?.end?.outcome.kind, "answered");
  });
});

test(
  "bounded interrupt Ask returns its own admitted Tell without awaiting predecessor settlement",
  { timeout: 30_000 },
  async () => {
    await withWaitedTellFixture(async ({ born }) => {
      const value = await born("a1000022", answering("unused"));
      const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
      const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: WAITED_TELL_NOW });
      try {
        const result = await waitTell(value, { body: "bounded interrupt", interrupt: true, timeoutMs: 0 });
        assert.equal(result.kind, "deadline");
        assert.equal(result.interrupt?.kind, "pending");
        assert.equal((await readTell(value.allocated.paths, result.tellId))?.body, "bounded interrupt");
        const heart = await readHeart(value.allocated.paths);
        assert.equal(heart.pause?.bodySequence, body.sequence);
        assert.equal(heart.latestBody?.sequence, body.sequence, "the held predecessor Body is still the latest Body");
        assert.equal(
          heart.latestBody?.end,
          undefined,
          "the Ask returned before the predecessor Body had a durable end",
        );
        assert.equal(heart.latestBody?.hung, undefined, "the predecessor Body is still live, not hung");
      } finally {
        leash.release();
      }
    });
  },
);
test("an exact canceled Ask is unanswered even after the same pending Tell binds a running successor", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-ask-canceled-");
  const value = await bornWorld(root, "ca1ce103");
  const paths = value.allocated.paths;
  const holder = (await HeldAkumaLeash.try(paths))!;
  const at = "2026-08-10T00:00:01.000Z";
  const observed: string[][] = [];
  try {
    const body = await holder.recordBody(paths, { leashTakenAt: at });
    await recordTell(paths, { kind: "tell", id: "exact", body: "original", recordedAt: at });
    const turn = await beginTurn(paths, { bodySequence: body.sequence, startedAt: at });
    await bindTellsToTurn(paths, { turnSequence: turn.sequence, tellIds: ["exact"], boundAt: at });
    await cancelBodyTurns(paths, { bodySequence: body.sequence, at });
    holder.release();
    const successor = (await HeldAkumaLeash.try(paths))!;
    try {
      const nextBody = await successor.recordBody(paths, { leashTakenAt: at });
      const next = await beginTurn(paths, { bodySequence: nextBody.sequence, startedAt: at });
      await bindTellsToTurn(paths, { turnSequence: next.sequence, tellIds: ["exact"], boundAt: at });
      const result = await executeAskAkuma({
        spawn: noBodyLaunch,
        path: value.world,
        id: value.allocated.id,
        body: "original",
        tellId: "exact",
        recordedAt: at,
        timeoutMs: 0,
        outcomeObserved: async (_id, identities) => {
          observed.push([...identities]);
        },
      });
      assert.equal(result.kind, "unanswered");
      assert.deepEqual(observed, [[`turn/${turn.sequence}`]]);
      assert.equal((await readTurn(paths, next.sequence))?.end, undefined);
      const page = await value.akuma.history();
      assert.ok(page.rows.some(row => row.text === `○ turn/${turn.sequence} · canceled`));
      const stream = value.akuma.stream()[Symbol.asyncIterator]();
      try {
        const first = await stream.next();
        assert.equal(first.done, false);
        if (!first.done) assert.equal(first.value.rows.find((row) => row.kind === "outcome")?.outcome.kind, "canceled");
      } finally {
        await stream.return?.();
      }
    } finally {
      successor.release();
    }
  } finally {
    holder.release();
  }
});

test("standalone tell admits and optionally observes its text answer", async () => {
  await withWaitedTellFixture(async ({ born, settle }) => {
    const first = await born("a1000020", answering("first answer"));
    const admitted = await first.akuma.tell("send only");
    assert.equal(admitted.akumaId, first.allocated.id);
    assert.equal((await readTell(first.allocated.paths, admitted.tellId))?.body, "send only");
    await settle();
    const second = await born("a1000021", answering("second answer"));
    const asked = await second.akuma.tell("await answer", { wait: true });
    assert.ok("state" in asked && asked.state === "done");
    assert.equal(asked.answer, "second answer");
    assert.equal(asked.at, WAITED_TELL_NOW);
    const recorded = await readTell(second.allocated.paths, asked.tellId);
    assert.ok(recorded?.binding);
    assert.equal(asked.turn, `turn/${recorded.binding.turnSequence}`);
  });
});

test("schema ask parses JSON and typed failures stay distinct", async () => {
  await withWaitedTellFixture(async ({ born, settle }) => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false };
    const decoded = await born("a1000002", answering('{"ok":true}'));
    const value = await decoded.akuma.ask("structured", { schema });
    await settle();
    assert.equal(value.kind, "answered");
    if (value.kind !== "answered") throw new Error("expected answer");
    assert.deepEqual(value.answer, { ok: true });
    const recorded = await readTell(decoded.allocated.paths, value.tellId);
    assert.equal(recorded?.schemaJson, canonicalDocument(schema).jsonText);

    for (const [draw, text, type, expected] of [
      ["a1000022", "42", "number", 42], ["a1000023", "null", "null", null],
    ] as const) {
      const scalar = await born(draw, answering(text));
      const result = await scalar.akuma.ask("structured", { schema: { type } });
      assert.ok(result.kind === "answered");
      assert.equal(result.answer, expected);
    }
    const empty = await born("a1000024", answering(""));
    assert.equal((await empty.akuma.ask("structured", { schema: { type: "string" } })).kind, "invalid-output");

    const invalid = await born("a1000003", answering("not-json"));
    assert.deepEqual((await invalid.akuma.ask("structured", { schema })).kind, "invalid-output");

    const mismatch = await born("a1000004", answering('{"ok":1}'));
    const unvalidated = await mismatch.akuma.ask("structured", { schema });
    assert.equal(unvalidated.kind, "answered");
    if (unvalidated.kind === "answered") assert.deepEqual(unvalidated.answer, { ok: 1 });

    const failing: ProviderAdapter = fixtureAdapter((input) => createProviderAttempt(input.signal, async (custody) => {
      custody.own({ closed: Promise.resolve(), forceDispose: async () => {} });
      return {
        admission: { fence: "api-fail" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "api-fail" } };
          },
        },
        completion: Promise.resolve({ kind: "failed" as const, diagnostic: "provider broke" }),
      };
    }));
    const failed = await born("a1000005", failing);
    const failedAsk = await failed.akuma.ask("structured", { schema });
    assert.equal(failedAsk.kind, "failed");
    assert.equal(failedAsk.diagnostic, "provider broke");
  });
});

test("plain Tell preserves its admission while caller cancellation releases the wake wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wake-cancel-"));
  const { allocated } = await bornWorld(root, "a1000009");
  const controller = new AbortController();
  const reason = new Error("cancel pending wake");
  let polls = 0;
  let released = false;
  const runtime: TellWakeRuntime = {
    async spawn() {
      return {
        completed: new Promise(() => undefined),
        async cancel() {},
        release() {
          released = true;
        },
      };
    },
    async schedule(milliseconds, signal) {
      polls += 1;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };
  try {
    const pending = new AkumaOwner(allocated.id, await World.at(root)).tell(
      "remain admitted",
      undefined,
      undefined,
      runtime,
      { signal: controller.signal },
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.ok(polls > 0, "wake polling must have started before cancellation");
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    const stoppedAt = polls;
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    assert.equal(polls, stoppedAt, "caller cancellation stops wake polling");
    assert.equal(released, true, "caller cancellation releases the wake child");
    assert.deepEqual(
      (await readHeart(allocated.paths)).pending.map((tell) => tell.body),
      ["remain admitted"],
      "cancellation does not revoke the already admitted Tell",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle returns untidy execution while preserving a pending tell", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-idle-pending-");
  const { allocated, akuma } = await bornWorld(root, "a1000010");
  const queued = await recordTell(allocated.paths, {
    kind: "tell",
    id: "queued",
    body: "later",
    recordedAt: "2026-08-10T00:00:01.000Z",
  });
  const timed = await akuma.idle({ timeoutMs: 100 });
  assert.equal(timed.reason, "completed");
  assert.ok(timed.status.state === "failed");
  assert.equal(timed.status.reason, "untidy");
  assert.equal(timed.status.akuma, allocated.id);
  assert.equal((await readTell(allocated.paths, "queued"))?.state, "pending");
  assert.ok(queued.kind === "recorded");
  assert.equal((await akuma.status()).work.pending?.[0]?.id, queued.tell.sequence);
});

const LIVE_WAIT_AT = "2026-10-01T00:00:00.000Z";

async function liveWaitFixture(context: TestContext, count = 1) {
  const root = await World.at(temporaryDirectory(context, "keiyaku-live-wait-"));
  const members = [];
  for (let index = 0; index < count; index += 1) {
    const born = await bornDirectAkuma({
      root,
      akumaName: "worker",
      draw: index.toString(16).padStart(8, "0"),
      createdAt: LIVE_WAIT_AT,
    });
    context.after(() => born.leash.release());
    const body = await born.leash.recordBody(born.paths, { leashTakenAt: LIVE_WAIT_AT });
    const turn = await beginTurn(born.paths, { bodySequence: body.sequence, startedAt: LIVE_WAIT_AT, call: "work" });
    members.push({ ...born, body, turn });
  }
  return { root, members };
}

function seedWaitNarration(
  member: Awaited<ReturnType<typeof liveWaitFixture>>["members"][number],
  count: number,
): void {
  const database = new DatabaseSync(member.paths.heart);
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    for (let index = 0; index < count; index += 1)
      insertActivityFact(database, {
        turnSequence: member.turn.sequence,
        event: { type: "thought", text: `reuse-wait-${index}` },
        at: LIVE_WAIT_AT,
      });
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}

test("live reads follow Tell binding, delivery, and receipt without timeline growth", async (context) => {
  const {
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  await recordTell(member.paths, { kind: "tell", id: "steer", body: "continue", recordedAt: LIVE_WAIT_AT });
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const first = await reader.read();
  const database = new DatabaseSync(member.paths.heart);
  const highest = database.prepare("SELECT MAX(sequence) AS value FROM timeline").get()?.value;
  database.close();
  await bindTellsToTurn(member.paths, {
    turnSequence: member.turn.sequence,
    tellIds: ["steer"],
    boundAt: LIVE_WAIT_AT,
  });
  const bound = await reader.read();
  assert.deepEqual(bound, first, "binding alone changes no projected delivery or pending evidence");
  assert.equal((await readTell(member.paths, "steer"))?.binding?.turnSequence, member.turn.sequence);
  await recordTellDeliveries(member.paths, [
    {
      tellId: "steer",
      route: "live",
      receipt: "required",
      turnSequence: member.turn.sequence,
      fence: "steer-fence",
      deliveredAt: LIVE_WAIT_AT,
    },
  ]);
  const delivered = await reader.read();
  assert.notDeepEqual(delivered, bound);
  const delivery = await readTell(member.paths, "steer");
  assert.equal(delivery?.deliveries.length, 1);
  assert.ok(delivered.status.recent?.some(row => row.id === delivery?.sequence && row.text.startsWith("⧗")));
  await recordTellReceipt(member.paths, {
    evidence: "fence",
    turnSequence: member.turn.sequence,
    fence: "steer-fence",
    kind: "consumed",
    receivedAt: LIVE_WAIT_AT,
  });
  const settled = await reader.read();
  assert.notDeepEqual(settled, delivered);
  assert.ok(settled.rows.some(row => row.id === delivery?.sequence && row.text.startsWith("▸")));
  assert.deepEqual(await reader.read(), settled);
  const after = new DatabaseSync(member.paths.heart);
  assert.equal(after.prepare("SELECT MAX(sequence) AS value FROM timeline").get()?.value, highest);
  after.close();
});

test("a live reader surfaces failed read, decode, schema, and commit attempts without retaining them", async (context) => {
  const {
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  seedWaitNarration(member, 1);
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  let previous = await reader.read();
  for (const failure of ["read", "commit", "decode", "schema"] as const) {
    const database = new DatabaseSync(member.paths.heart);
    const version = database.prepare("SELECT version FROM akuma_schema").get()?.version;
    if (failure === "decode") database.exec("UPDATE activity SET event_json = '{}'");
    if (failure === "schema") database.exec("PRAGMA ignore_check_constraints=ON; UPDATE akuma_schema SET version = -1");
    const prepare = DatabaseSync.prototype.prepare;
    const exec = DatabaseSync.prototype.exec;
    let commits = 0;
    let selected = false;
    const injectedRead = context.mock.method(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, sql: string) {
        if (sql.startsWith("WITH selected")) {
          selected = true;
          if (failure === "read") throw new Error("selected read failed");
        }
        return prepare.call(this, sql);
      },
    );
    const injectedCommit = context.mock.method(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, sql: string) {
        if (sql === "COMMIT" && selected && failure === "commit") {
          commits += 1;
          throw new Error("selected commit failed");
        }
        return exec.call(this, sql);
      },
    );
    await assert.rejects(reader.read());
    injectedRead.mock.restore();
    injectedCommit.mock.restore();
    if (failure === "commit") assert.equal(commits, 1, "no retry after admission");
    if (failure === "decode")
      database
        .prepare("UPDATE activity SET event_json = ?")
        .run(JSON.stringify({ type: "thought", text: "reuse-wait-0" }));
    if (failure === "schema") database.prepare("UPDATE akuma_schema SET version = ?").run(version!);
    database.close();
    const recovered = await reader.read();
    assert.deepEqual(recovered, previous, `${failure} leaves no partially decoded or failed observation behind`);
    previous = recovered;
  }
});

test("wait cancellation during Heart admission closes the observation without admitting a round", async (context) => {
  const {
    root,
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  const blocker = new DatabaseSync(member.paths.heart);
  blocker.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");
  blocker.prepare("SELECT version FROM akuma_schema").get();
  const controller = new AbortController();
  const reason = new Error("cancel read admission");
  const waiting = executeWaitAkuma({
    path: root,
    ids: [member.id],
    completion: "all",
    signal: controller.signal,
  });
  const rejected = assert.rejects(waiting, (error) => error === reason);
  const timer = setTimeout(() => controller.abort(reason), 20);
  await rejected;
  clearTimeout(timer);
  blocker.close();
  await finishBodyIfIdle(member.paths, { sequence: member.body.sequence, at: LIVE_WAIT_AT });
  member.leash.release();
  const result = await executeWaitAkuma({
    path: root,
    ids: [member.id],
    completion: "all",
    timeoutMs: 0,
  });
  assert.equal(result.reason, "completed");
  const claim = await HeldAkumaLeash.try(member.paths);
  assert.ok(claim, "no observation retains a free seat");
  claim.release();
});

test("plural wait keeps an unreadable member local and reads it anew when it recovers", async (context) => {
  const { root, members } = await liveWaitFixture(context, 2);
  const first = members[0]!;
  const second = members[1]!;
  seedWaitNarration(first, 1);
  seedWaitNarration(second, 1);
  const prepare = DatabaseSync.prototype.prepare;
  let selections = 0;
  const injected = context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("WITH selected")) {
      selections += 1;
      // The second member of the observation is unreadable; its peer is not.
      if (selections === 2) throw new Error("transient selected read failure");
    }
    return prepare.call(this, sql);
  });
  const observer = createAkumaWaitObserver(root, members.map((member) => member.id), true);
  try {
    await observer.observe(AbortSignal.timeout(1_000));
    const [readable, unreadable] = members.map((member) => observer.items.get(member.id));
    assert.ok(readable?.state === "running" && Array.isArray(readable.events) && readable.events.length === 3);
    assert.ok(unreadable?.state === "running", "an unreadable tail leaves the member's work intact");
    assert.ok(unreadable.events && "reason" in unreadable.events);
    assert.match(unreadable.events.reason, /transient selected read failure/u);
  } finally {
    injected.mock.restore();
  }
  try {
    await observer.observe(AbortSignal.timeout(1_000));
    for (const member of members) {
      const item = observer.items.get(member.id);
      assert.ok(item?.state === "running" && Array.isArray(item.events));
      assert.equal(item.events.length, 3, "a later read replaces the failure");
    }
  } finally {
    observer.clear();
  }
});
