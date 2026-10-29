import { fixtureAdapter } from "./support/akuma-tell.js";
import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { Akuma, AkumaProviderError, Schema, type AkumaIdleResult } from "../src/akuma/index.js";
import { AkumaOwner } from "../src/akuma/akuma-owner.js";
import { driveAkumaBody, type TellWakeRuntime } from "../src/akuma/body.js";
import {
  appendActivity, beginTurn, bindTellsToTurn, breakBody, cancelBodyTurns, decidePendingTellDisposition, endTurn, finishBodyIfIdle,
  HeldAkumaLeash, readHeart, readTell, readTurn, recordTell, recordTellDeliveries, recordTellReceipt,
  resolvePendingTellDisposition,
} from "../src/akuma/heart/index.js";
import { bornDirectAkuma } from "./support/akuma-fixtures.js";
import { createLiveStatusReader, defaultWaitComplete } from "../src/akuma/akuma-observe.js";
import { executeWaitAkuma } from "../src/akuma/akuma-wait.js";
import { DatabaseSync } from "node:sqlite";
import { insertActivityFact, finishBodyFact } from "../src/akuma/heart/rows.js";
import { type ProviderAdapter } from "../src/akuma/provider.js";
import { executeAskAkuma } from "../src/akuma/akuma-selection-execution.js";
import {
  deferred,
  installAkumaBodyPidReceipt,
  settlementProbe,
  waitForCondition,
  waitForPidReceiptExit,
} from "./support/process.js";
import { cliJson } from "./support/cli-fixtures.js";
import type { AkumaAskResult } from "../src/akuma/selection-observation.js";
import { schemaJsonText } from "../src/akuma/schema.js";
import { World } from "../src/world.js";
import { debtAuthorityFile } from "./support/debt.js";

function freezeWalk(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  assert.ok(Object.isFrozen(value));
  if (Array.isArray(value)) {
    for (const entry of value) freezeWalk(entry);
    return;
  }
  for (const entry of Object.values(value)) freezeWalk(entry);
}

/**
 * Bounds the seed-Tell binding wait and ends it on a dead outcome: a settled driving pump, a missing
 * Tell, or a terminal delivery that never bound a Turn.
 */
async function waitForSeedBinding(paths: Parameters<typeof readTell>[0], driven: Promise<unknown>): Promise<void> {
  const bodySettled = settlementProbe(driven, () => "the driving Body pump settled without binding the seed Tell");
  await waitForCondition(
    "the seed Tell to bind to its running Turn",
    async () => (await readTell(paths, "seed"))?.binding !== undefined,
    {
      terminalState: async () => {
        const tell = await readTell(paths, "seed");
        if (tell === null) return "the recorded seed Tell is missing from Heart";
        if (tell.state === "told" && tell.binding === undefined)
          return "the seed Tell reached terminal delivery without a Turn binding";
        return bodySettled();
      },
    },
  );
}

test("Schema.zod and JsonSchema freeze a canonical bounded document", () => {
  const fromZod = Schema.zod(z.object({ ok: z.boolean() }).strict());
  const again = Schema.zod(z.object({ ok: z.boolean() }).strict());
  const fromJson = Schema.json(
    { required: ["ok"], type: "object", properties: { ok: { type: "boolean" } } },
    (value) => value as { ok: boolean },
  );
  const shuffled = Schema.json(
    { properties: { ok: { type: "boolean" } }, required: ["ok"], type: "object" },
    (value) => value as { ok: boolean },
  );
  freezeWalk(fromZod);
  freezeWalk(fromZod.jsonSchema);
  freezeWalk(fromJson.jsonSchema);
  assert.deepEqual(fromJson.jsonSchema, shuffled.jsonSchema);
  assert.equal(typeof fromJson.decode, "function");
  assert.deepEqual(fromZod.jsonSchema, again.jsonSchema);
  assert.deepEqual(fromJson.decode({ ok: false }), { ok: false });
  const custom = Schema.json({ type: "string" }, (value) => String(value).toUpperCase());
  assert.equal(custom.decode("ok"), "OK");
  assert.throws(() => Schema.zod(z.bigint()), /represented in JSON Schema/u);
  assert.throws(() => Schema.json({ type: "object", extra: "x".repeat(70_000) }, (value) => value), /byte/u);
  assert.throws(() => Schema.json({ type: "object", description: "é".repeat(40_000) }, (value) => value), /byte/u);
});

test("public ./akuma barrel exposes only the contracted names", async () => {
  const exported = await import("../src/akuma/index.js");
  assert.deepEqual(
    Object.keys(exported).sort(),
    [
      "ALLOWED_ACTIONS",
      "Akuma",
      "AkumaArchetypeError",
      "AkumaBusyError",
      "AkumaDecodeError",
      "AkumaNotBornError",
      "AkumaProviderError",
      "Schema",
      "listArchetypeDefinitions",
    ].sort(),
  );
  assert.equal("AkumaOwner" in exported, false);
  assert.equal("TellResult" in exported, false);
});

test("package root exposes the same public Akuma values without private mechanisms", async () => {
  const subpath = await import("../src/akuma/index.js");
  const root: typeof subpath = await import("../src/index.js");
  for (const name of Object.keys(subpath) as Array<keyof typeof subpath>) {
    assert.strictEqual(root[name], subpath[name], name);
  }
  for (const name of ["AkumaOwner", "HeldAkumaLeash", "driveAkumaBody", "readHeart"]) {
    assert.equal(name in root, false, name);
  }
  const schema: import("../src/index.js").Schema<{ ok: boolean }> = root.Schema.zod(z.object({ ok: z.boolean() }));
  const options: import("../src/index.js").AkumaAskOptions<{ ok: boolean }> = { schema };
  assert.strictEqual(options.schema, schema);
  assert.deepEqual(schema.decode({ ok: true }), { ok: true });
});

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
    const selected = Akuma.select(value.world, value.allocated.id);
    assert.equal((await selected.status()).id, value.allocated.id);
    assert.equal(Array.isArray((await selected.history()).rows), true);
    assert.equal((await selected.idle({ timeoutMs: 0 })).status.id, value.allocated.id);
    const asked = await selected.ask("standalone", { timeoutMs: 5_000 });
    assert.deepEqual(asked.observation, { reason: "answered", answer: "standalone answer" });
    assert.ok(["killed", "already-stopped", "already-killed"].includes(await selected.kill()));
  });
});

import { answering, bornWorld, fixtureRuntime, installTellRuntime, settleFixtureBodies } from "./support/akuma-tell.js";

const WAITED_TELL_NOW = "2026-08-10T00:00:01.000Z";
type WaitedTellWorld = Awaited<ReturnType<typeof bornWorld>>;
type WaitedTellFixture = {
  root: string;
  born(suffix: string, adapter: ProviderAdapter, now?: string): Promise<WaitedTellWorld>;
  settle(): Promise<void>;
  withRuntime<T>(runtime: TellWakeRuntime, run: () => Promise<T>): Promise<T>;
};
type WaitedTellOptions = Omit<Parameters<typeof executeAskAkuma>[0], "path" | "id">;

function waitTell(world: WaitedTellWorld, options: WaitedTellOptions) {
  return executeAskAkuma({ path: world.world, id: world.allocated.id, ...options });
}

async function withWaitedTellFixture<T>(run: (fixture: WaitedTellFixture) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-ask-"));
  const bodies: Promise<unknown>[] = [];
  const adapters = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restore = installTellRuntime(fixtureRuntime(bodies, adapters));
  const settle = () => settleFixtureBodies(bodies);
  const born = async (suffix: string, adapter: ProviderAdapter, now = WAITED_TELL_NOW) => {
    const fixture = await bornWorld(root, suffix);
    adapters.set(fixture.allocated.paths.directory, { adapter, now });
    return fixture;
  };
  try {
    return await run({
      root,
      born,
      settle,
      async withRuntime(runtime, action) {
        const restoreRuntime = installTellRuntime(runtime);
        try {
          return await action();
        } finally {
          restoreRuntime();
        }
      },
    });
  } finally {
    restore();
    await settle();
    rmSync(root, { recursive: true, force: true });
  }
}

function gatedAnswer(gate: Promise<string>, started?: () => void): ProviderAdapter {
  return fixtureAdapter(async () => ({
    admission: { fence: "waited-fixture" },
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "session" as const, coordinate: { sessionId: "waited-fixture" } };
        started?.();
      },
    },
    completion: gate.then((answer) => ({ kind: "answered" as const, answer, historyId: "waited-fixture" })),
    resource: { abort: async () => {} },
  }));
}

const dormantTellRuntime: TellWakeRuntime = {
  async spawn() {
    return { pid: 0, exited: new Promise(() => undefined), async terminate() {}, release() {} };
  },
};

test("bounded Tell and zero window preserve exact admission through waited Tell cancellation", async () => {
  await withWaitedTellFixture(async ({ born, settle }) => {
    const answered = await born("a1000010", answering("exact answer"));
    const observed = await waitTell(answered, { body: "answer this", timeoutMs: 1_000 });
    assert.equal(observed.tell.admission.tellId, observed.tell.row.tellId);
    assert.deepEqual(observed.observation, { reason: "answered", answer: "exact answer" });

    const late = deferred<string>();
    const delayed = await born("a1000018", gatedAnswer(late.promise));
    const forced = setTimeout(() => late.resolve("forced"), 400);
    const startedAt = performance.now();
    const deadline = await waitTell(delayed, { body: "late", timeoutMs: 0 });
    const elapsed = performance.now() - startedAt;
    clearTimeout(forced);
    assert.deepEqual(deadline.observation, { reason: "deadline" });
    assert.ok(elapsed < 200, `an expired window must not wait for delivery (waited ${elapsed}ms)`);
    assert.equal((await readTell(delayed.allocated.paths, deadline.tell.admission.tellId))?.body, "late");
    late.resolve("too late");
    await settle();
    assert.equal((await readTell(delayed.allocated.paths, deadline.tell.admission.tellId))?.state, "told");

    const started = deferred<void>();
    const finish = deferred<string>();
    const canceled = await born("a1000015", gatedAnswer(finish.promise, started.resolve));
    const controller = new AbortController();
    const reason = new Error("stop observing the admitted Tell");
    const tellId = "waited-cancel-tell";
    const pending = waitTell(canceled, { body: "finish later", tellId, timeoutMs: 5_000, signal: controller.signal });
    await started.promise;
    await waitForCondition("the admitted Tell to bind its Turn", async () => (await readTell(canceled.allocated.paths, tellId))?.binding !== undefined);
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    const admitted = await readTell(canceled.allocated.paths, tellId);
    assert.equal(admitted?.body, "finish later");
    assert.notEqual(admitted?.binding, undefined, "cancellation does not retract the admitted Tell");
    finish.resolve("late answer");
    await settle();
    const settled = await readTell(canceled.allocated.paths, tellId);
    assert.equal(settled?.state, "told");
    const turn = settled?.binding === undefined ? null : await readTurn(canceled.allocated.paths, settled.binding.turnSequence);
    assert.equal(turn?.end?.outcome.kind, "answered");
  });
});

test("waited schema Tell decodes at the CLI boundary and bounded interrupt Tell keeps provider errors distinct", async (context) => {
  await withWaitedTellFixture(async ({ root, born }) => {
    const schemaPath = join(root, "answer.schema.json");
    writeFileSync(schemaPath, JSON.stringify({
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    }));
    const answered = await born("a1000013", answering('{"ok":true}'));
    const argv = (akuma: string) =>
      ["-C", answered.world, "ask", akuma, "--schema", schemaPath, "--wait", "5s", "structured"] as const;
    const result = await cliJson<AkumaAskResult>(argv(answered.allocated.id), {
      environment: {},
      readStdin: async () => "",
    });
    assert.deepEqual(result.value.observation, { reason: "answered", answer: { ok: true } });

    const invalid = await born("a1000014", answering("not-json"));
    const invalidResult = await cliJson<AkumaAskResult>(
      ["-C", invalid.world, "ask", invalid.allocated.id, "--schema", schemaPath, "--wait", "5s", "structured"],
      { environment: {}, readStdin: async () => "" },
    );
    assert.equal(invalidResult.value.observation.reason, "invalid-output");
    assert.equal(invalidResult.exit, 3, "invalid schema output fails like an invalid call answer");

    const interrupt = await born("a1000012", answering("unused"));
    context.mock.method(AkumaOwner.prototype, "admitInterrupt", async () => ({ kind: "unavailable" as const, evidence: "hung" as const }));
    await assert.rejects(
      executeAskAkuma({ path: interrupt.world, id: interrupt.allocated.id, body: "interrupt", timeoutMs: 0, interrupt: true }),
      (error) => error instanceof AkumaProviderError && error.message === "Tell interrupt unavailable: hung",
    );
  });
});

test("bounded interrupt Ask returns its own admitted Tell without awaiting predecessor settlement", async () => {
  await withWaitedTellFixture(async ({ born }) => {
    const value = await born("a1000022", answering("unused"));
    const leash = (await HeldAkumaLeash.try(value.allocated.paths))!;
    const body = await leash.recordBody(value.allocated.paths, { leashTakenAt: WAITED_TELL_NOW });
    try {
      const started = performance.now();
      const result = await waitTell(value, { body: "bounded interrupt", interrupt: true, timeoutMs: 0 });
      assert.deepEqual(result.observation, { reason: "deadline" });
      assert.equal(result.tell.interruption?.kind, "pending");
      assert.ok(performance.now() - started < 200, "an expired Ask must not wait for predecessor settlement");
      assert.equal((await readTell(value.allocated.paths, result.tell.admission.tellId))?.body, "bounded interrupt");
      assert.equal((await readHeart(value.allocated.paths)).pause?.bodySequence, body.sequence);
    } finally {
      leash.release();
    }
  });
});
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
      const result = await executeAskAkuma({ path: value.world, id: value.allocated.id, body: "original", tellId: "exact", recordedAt: at,
        timeoutMs: 0, outcomeObserved: async (_id, identities) => { observed.push([...identities]); } });
      assert.deepEqual(result.observation, { reason: "unanswered" });
      assert.deepEqual(observed, [[`turn/${turn.sequence}`]]);
      assert.equal((await readTurn(paths, next.sequence))?.end, undefined);
      const page = await value.akuma.history();
      assert.equal(page.rows.find((row) => row.kind === "outcome")?.outcome.kind, "canceled");
      const stream = value.akuma.stream()[Symbol.asyncIterator]();
      try {
        const first = await stream.next();
        assert.equal(first.done, false);
        if (!first.done) assert.equal(first.value.rows.find((row) => row.kind === "outcome")?.outcome.kind, "canceled");
      } finally { await stream.return?.(); }
    } finally { successor.release(); }
  } finally { holder.release(); }
});

test("terminal Tell delivery reports answered and explicit unanswered results", async () => {
  await withWaitedTellFixture(async ({ born, withRuntime, settle }) => {
    const terminal = await born("a1000016", answering("edge answer"));
    const handle = new AkumaOwner(terminal.allocated.id, terminal.world);
    const recordedAt = "2026-08-10T00:00:02.000Z";
    const recorded = await handle.tell("edge", undefined, recordedAt);
    await settle();
    const observed = await handle.tellOutcome(recorded.admission.tellId, { timeoutMs: 0 });
    assert.equal(observed.reason, "completed", "a terminal result witnessed at the expired deadline wins");
    assert.equal(observed.outcome?.kind, "answered");
    if (observed.outcome?.kind === "answered") assert.equal(observed.outcome.answer, "edge answer");

    await withRuntime(dormantTellRuntime, async () => {
      const envelope = await waitTell(terminal, {
        body: "edge",
        tellId: recorded.admission.tellId,
        recordedAt,
        timeoutMs: 0,
      });
      assert.deepEqual(envelope.observation, { reason: "answered", answer: "edge answer" });

      const unanswered = await born("a1000017", answering("unused"));
      const tellId = "terminal-without-turn";
      await recordTell(unanswered.allocated.paths, { kind: "tell", id: tellId, body: "gone", recordedAt });
      await recordTellReceipt(unanswered.allocated.paths, { kind: "custody", evidence: "exact", tellId, receivedAt: recordedAt });
      const result = await waitTell(unanswered, { body: "gone", tellId, recordedAt, timeoutMs: 0 });
      assert.equal(result.tell.row.state, "told");
      assert.deepEqual(result.observation, { reason: "unanswered" });
    });
  });
});

test("standalone tell admits without awaiting while ask defaults to unbounded observation", async () => {
  await withWaitedTellFixture(async ({ born, settle }) => {
    const first = await born("a1000020", answering("first answer"));
    const admitted = await first.akuma.tell("send only");
    assert.equal(admitted.akuma, first.allocated.id);
    assert.equal(admitted.tell.row.text, "send only");
    await settle();
    const second = await born("a1000021", answering("second answer"));
    const asked = await second.akuma.ask("await answer");
    assert.deepEqual(asked.observation, { reason: "answered", answer: "second answer" });
  });
});

test("schema ask decodes JSON and typed failures stay distinct", async () => {
  await withWaitedTellFixture(async ({ born, settle }) => {
    const schema = Schema.zod(z.object({ ok: z.boolean() }).strict());
    const decoded = await born("a1000002", answering('{"ok":true}'));
    const value = await decoded.akuma.ask("structured", { schema });
    await settle();
    assert.deepEqual(value.observation, { reason: "answered", answer: { ok: true } });
    const fact = (await decoded.akuma.history()).rows.find((row) => row.kind === "tell");
    assert.equal(fact?.kind, "tell");
    if (fact?.kind === "tell") {
      const recorded = await readTell(decoded.allocated.paths, fact.tellId);
      assert.equal(recorded?.schemaJson, schemaJsonText(schema));
    }

    const invalid = await born("a1000003", answering("not-json"));
    assert.deepEqual((await invalid.akuma.ask("structured", { schema })).observation.reason, "invalid-output");

    const mismatch = await born("a1000004", answering('{"ok":1}'));
    assert.deepEqual((await mismatch.akuma.ask("structured", { schema })).observation.reason, "invalid-output");

    const failing: ProviderAdapter = fixtureAdapter(async () => ({
      admission: { fence: "api-fail" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "api-fail" } };
        },
      },
      completion: Promise.resolve({ kind: "failed" as const, diagnostic: "provider broke" }),
      resource: { abort: async () => {} },
    }));
    const failed = await born("a1000005", failing);
    assert.deepEqual((await failed.akuma.ask("structured", { schema })).observation, { reason: "failed", diagnostic: "provider broke" });
  });
});

test("tell refuses schema before admission; ask checks options before addressing", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-routing-");
  const akuma = Akuma.select(await World.at(root), "aku/claude/a1000006");
  const schema = Schema.zod(z.object({ ok: z.boolean() }).strict());
  await assert.rejects(akuma.tell("structured", { schema } as never), /use ask/u);
  await assert.rejects(akuma.ask("structured", { timeoutMs: -1 }), /timeoutMs/u);
  const controller = new AbortController();
  const reason = new Error("cancel before admission");
  controller.abort(reason);
  await assert.rejects(akuma.ask("structured", { schema, interrupt: true, signal: controller.signal }),
    (error: unknown) => error === reason);
});

test("plain Tell preserves its admission while caller cancellation releases the wake wait", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wake-cancel-"));
  const { allocated, akuma } = await bornWorld(root, "a1000009");
  const controller = new AbortController();
  const reason = new Error("cancel pending wake");
  let polls = 0;
  let released = false;
  const runtime: TellWakeRuntime = {
    async spawn() {
      return {
        pid: 0,
        exited: new Promise(() => undefined),
        async terminate() {},
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
  const restoreTellRuntime = installTellRuntime(runtime);
  try {
    const pending = akuma.tell("remain admitted", { signal: controller.signal });
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
    restoreTellRuntime();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle resolves the settling life with the final status", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-idle-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const { allocated, akuma } = await bornWorld(root, "a1000008");
    fixtures.set(allocated.paths.directory, { adapter: answering("done"), now: "2026-08-10T00:00:01.000Z" });
    await akuma.tell("hello");
    await settleFixtureBodies(bodies);
    const settled: AkumaIdleResult = await akuma.idle();
    assert.equal(settled.reason, "completed");
    assert.equal(settled.status.life, "asleep");
    assert.equal(settled.status.id, allocated.id);
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle after kill names the killed life", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-idle-killed-"));
  let release: (() => void) | undefined;
  let body: Promise<unknown> | undefined;
  try {
    const { allocated, akuma } = await bornWorld(root, "a1000011");
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging: ProviderAdapter = fixtureAdapter(async () => ({
      admission: { fence: "api-hang" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "api-idle-kill" } };
          await held;
        },
      },
      completion: held.then(() => ({ kind: "answered" as const, answer: "late", historyId: "hang" })),
      resource: {
        abort: async () => {
          release?.();
        },
      },
    }));
    await recordTell(allocated.paths, {
      kind: "tell",
      id: "seed",
      body: "start",
      recordedAt: "2026-08-10T00:00:01.000Z",
    });
    body = driveAkumaBody({ paths: allocated.paths }, hanging, { now: () => "2026-08-10T00:00:02.000Z" });
    await waitForSeedBinding(allocated.paths, body);
    assert.equal(await akuma.kill(), "killed");
    await body;
    body = undefined;
    await waitForCondition("the killed life to become observable", async () => (await akuma.status()).life === "killed");
    const killed = await akuma.idle();
    assert.equal(killed.reason, "completed");
    assert.equal(killed.status.life, "killed");
    assert.equal(killed.status.id, allocated.id);
  } finally {
    release?.();
    await body?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle returns untidy execution while preserving a pending tell", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-idle-pending-");
  const { allocated, akuma } = await bornWorld(root, "a1000010");
  await recordTell(allocated.paths, {
    kind: "tell",
    id: "queued",
    body: "later",
    recordedAt: "2026-08-10T00:00:01.000Z",
  });
  const timed = await akuma.idle({ timeoutMs: 100 });
  assert.equal(timed.reason, "completed");
  assert.equal(timed.status.life, "untidy");
  assert.equal(timed.status.id, allocated.id);
  assert.ok(timed.status.timeline.entries.some((entry) =>
    entry.kind === "row" && entry.row.kind === "tell" && entry.row.tellId === "queued" && entry.row.state === "pending",
  ));
});

const LIVE_WAIT_AT = "2026-10-01T00:00:00.000Z";

async function liveWaitFixture(context: TestContext, count = 1) {
  const root = await World.at(temporaryDirectory(context, "keiyaku-live-wait-"));
  const members = [];
  for (let index = 0; index < count; index += 1) {
    const born = await bornDirectAkuma({
      root,
      archetype: "worker",
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

test("unchanged scoped reads decode and project once and end their scope at clear", async (context) => {
  const {
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  seedWaitNarration(member, 12);
  const parse = JSON.parse;
  let decodes = 0;
  context.mock.method(JSON, "parse", (text: string, ...args: unknown[]) => {
    if (text.includes('"text":"reuse-wait-')) decodes += 1;
    return Reflect.apply(parse, JSON, [text, ...args]);
  });
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const input = { aperture: "monitoring" as const };
  const rounds = [];
  for (let round = 0; round < 4; round += 1) rounds.push(await reader.read(input));
  assert.equal(decodes, 12, "four unchanged reads decode the frontier once");
  assert.equal(new Set(rounds.map((round) => round.rows)).size, 1, "one projectTurns frontier across unchanged rounds");
  assert.equal(
    new Set(rounds.map((round) => round.status.timeline)).size,
    1,
    "one selection across normalized-equivalent rounds",
  );
  assert.ok(rounds.every((round) => round.status.life === "running"));
  assert.equal(rounds[0]!.rows.length, 14);
  assert.ok(rounds[0]!.rows.some((row) => row.kind === "thought" && row.text === "reuse-wait-0"));
  reader.clear();
  const fresh = await reader.read(input);
  assert.equal(decodes, 24, "a cleared reader decodes anew");
  assert.equal(new Set([...rounds, fresh].map((round) => round.rows)).size, 2, "clear drops the retained frontier");
});

test("scoped status invalidates Tell binding, delivery, and receipt without timeline growth", async (context) => {
  const {
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  await recordTell(member.paths, { kind: "tell", id: "steer", body: "continue", recordedAt: LIVE_WAIT_AT });
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const input = { aperture: "monitoring" as const };
  const first = await reader.read(input);
  const database = new DatabaseSync(member.paths.heart);
  const highest = database.prepare("SELECT MAX(sequence) AS value FROM timeline").get()?.value;
  database.close();
  await bindTellsToTurn(member.paths, {
    turnSequence: member.turn.sequence,
    tellIds: ["steer"],
    boundAt: LIVE_WAIT_AT,
  });
  const bound = await reader.read(input);
  assert.notStrictEqual(bound.rows, first.rows);
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
  const delivered = await reader.read(input);
  assert.notStrictEqual(delivered.rows, bound.rows);
  assert.equal(delivered.rows.find((row) => row.kind === "tell")?.deliveries.length, 1);
  assert.equal(delivered.rows.find((row) => row.kind === "tell")?.state, "pending");
  await recordTellReceipt(member.paths, {
    evidence: "fence",
    turnSequence: member.turn.sequence,
    fence: "steer-fence",
    kind: "consumed",
    receivedAt: LIVE_WAIT_AT,
  });
  const settled = await reader.read(input);
  assert.notStrictEqual(settled.rows, delivered.rows);
  assert.equal(settled.rows.find((row) => row.kind === "tell")?.state, "told");
  assert.strictEqual((await reader.read(input)).rows, settled.rows);
  const after = new DatabaseSync(member.paths.heart);
  assert.equal(after.prepare("SELECT MAX(sequence) AS value FROM timeline").get()?.value, highest);
  after.close();
});

test("a cached frontier rebuilds on Turn closure and preserves final rows idle status omits", async (context) => {
  const {
    root,
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  seedWaitNarration(member, 12);
  let judgements = 0;
  let closing: Promise<void> | undefined;
  const result = await executeWaitAkuma({
    path: root,
    ids: [member.id],
    completion: "all",
    timeoutMs: 5_000,
    // A custom judge forces full rounds without a live viewer and keeps default completion semantics.
    predicate(status) {
      judgements += 1;
      if (judgements === 1) {
        closing = (async () => {
          await endTurn(member.paths, {
            turnSequence: member.turn.sequence,
            outcome: { kind: "failed", diagnostic: "done" },
            completedAt: LIVE_WAIT_AT,
          });
          await finishBodyIfIdle(member.paths, { sequence: member.body.sequence, at: LIVE_WAIT_AT });
          member.leash.release();
        })();
      }
      return defaultWaitComplete(status);
    },
  });
  await closing;
  assert.equal(result.reason, "completed");
  assert.ok(judgements >= 2);
  assert.equal(result.observations[0]?.life, "asleep");
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const final = await reader.read({ aperture: "monitoring" });
  assert.equal(final.status.life, "asleep");
  assert.equal(final.status.timeline.kind, "idle");
  assert.equal(final.status.timeline.entries.length, 0);
  assert.equal(final.rows.filter((row) => row.kind === "thought").length, 12);
  assert.equal(final.rows.at(-1)?.kind, "outcome");
});

test("a scoped reader discards failed read, decode, schema, and commit attempts", async (context) => {
  const {
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  seedWaitNarration(member, 1);
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const input = { aperture: "monitoring" as const };
  let previous = await reader.read(input);
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
    await assert.rejects(reader.read(input));
    injectedRead.mock.restore();
    injectedCommit.mock.restore();
    if (failure === "commit") assert.equal(commits, 1, "no retry after admission");
    if (failure === "decode")
      database
        .prepare("UPDATE activity SET event_json = ?")
        .run(JSON.stringify({ type: "thought", text: "reuse-wait-0" }));
    if (failure === "schema") database.prepare("UPDATE akuma_schema SET version = ?").run(version!);
    database.close();
    const recovered = await reader.read(input);
    assert.notStrictEqual(recovered.rows, previous.rows, `${failure} invalidates even when original bytes return`);
    assert.deepEqual(recovered.rows, previous.rows);
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

test("scoped reader reuse refreshes life across Body end, free-seat races, and succession", async (context) => {
  const {
    root,
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const input = { aperture: "monitoring" as const };
  const first = await reader.read(input);
  const original = HeldAkumaLeash.try;
  let raced = false;
  const injected = context.mock.method(HeldAkumaLeash, "try", async (paths: Parameters<typeof original>[0]) => {
    if (paths.heart === member.paths.heart && !raced) {
      raced = true;
      const database = new DatabaseSync(paths.heart);
      try {
        finishBodyFact(database, { sequence: member.body.sequence, at: LIVE_WAIT_AT });
      } finally {
        database.close();
      }
      member.leash.release();
    }
    return await original(paths);
  });
  const ended = await reader.read(input);
  injected.mock.restore();
  assert.equal(ended.status.life, "asleep", "refresh under the free claim wins over the old running read");
  assert.strictEqual(ended.rows, first.rows, "fresh life does not force unchanged projection");
  const successor = (await HeldAkumaLeash.try(member.paths))!;
  context.after(() => successor.release());
  const body = await successor.recordBody(member.paths, { leashTakenAt: LIVE_WAIT_AT });
  assert.equal((await reader.read(input)).status.life, "running");
  assert.strictEqual((await reader.read(input)).rows, first.rows);
  await breakBody(member.paths, { sequence: body.sequence, end: "put-down", at: LIVE_WAIT_AT });
  successor.release();
  assert.equal((await reader.read(input)).status.life, "stranded");
  const final = await executeWaitAkuma({ path: root, ids: [member.id], completion: "all", timeoutMs: 0 });
  assert.equal(final.reason, "completed", "completion precedes a passed deadline");
});

test("releasing retention protection removes evidence from the memo without timeline growth", async (context) => {
  const {
    members: [member],
  } = await liveWaitFixture(context);
  assert.ok(member);
  await recordTell(member.paths, { kind: "tell", id: "retired", body: "protected", recordedAt: LIVE_WAIT_AT });
  await decidePendingTellDisposition(member.paths, {
    bodySequence: member.body.sequence,
    at: LIVE_WAIT_AT,
    handoff: true,
  });
  await recordTellDeliveries(member.paths, [
    {
      tellId: "retired",
      route: "launch",
      turnSequence: member.turn.sequence,
      fence: "retained-launch",
      deliveredAt: LIVE_WAIT_AT,
    },
  ]);
  seedWaitNarration(member, 5_501);
  await appendActivity(member.paths, {
    turnSequence: member.turn.sequence,
    event: { type: "note", text: "compact" },
    at: LIVE_WAIT_AT,
  });
  const reader = createLiveStatusReader(member.paths, member.id);
  context.after(reader.clear);
  const input = { aperture: "receipt" as const, admittedTellId: "retired" };
  const protectedView = await reader.read(input);
  assert.ok(protectedView.rows.some((row) => row.kind === "tell" && row.tellId === "retired"));
  const database = new DatabaseSync(member.paths.heart);
  const highest = database.prepare("SELECT MAX(sequence) AS value FROM timeline").get()?.value;
  database.close();
  assert.equal(await resolvePendingTellDisposition(member.paths, member.body.sequence, LIVE_WAIT_AT), true);
  const released = await reader.read(input);
  assert.notStrictEqual(released.rows, protectedView.rows);
  assert.equal(
    released.rows.some((row) => row.kind === "tell" && row.tellId === "retired"),
    false,
  );
  assert.equal(await readTell(member.paths, "retired"), null);
  const after = new DatabaseSync(member.paths.heart);
  assert.equal(after.prepare("SELECT MAX(sequence) AS value FROM timeline").get()?.value, highest);
  after.close();
});

test("plural wait drops an unreadable member memo and decodes anew when it recovers", async (context) => {
  const { root, members } = await liveWaitFixture(context, 2);
  const first = members[0]!;
  const second = members[1]!;
  seedWaitNarration(first, 1);
  seedWaitNarration(second, 1);
  const prepare = DatabaseSync.prototype.prepare;
  let failNextRead = false;
  let reads = 0;
  const controller = new AbortController();
  const reason = new Error("recovery witnessed");
  context.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
    if (sql.startsWith("WITH selected")) {
      reads += 1;
      // The second round's first member is unreadable; the third round reads both again.
      if (failNextRead) {
        failNextRead = false;
        throw new Error("transient selected read failure");
      }
      if (reads === 2) failNextRead = true;
      if (reads === 6) controller.abort(reason);
    }
    return prepare.call(this, sql);
  });
  const parse = JSON.parse;
  let decodes = 0;
  context.mock.method(JSON, "parse", (text: string, ...args: unknown[]) => {
    if (text.includes('"text":"reuse-wait-')) decodes += 1;
    return Reflect.apply(parse, JSON, [text, ...args]);
  });
  // A custom judge forces full rounds without a live viewer, so the unreadable round is a real round.
  await assert.rejects(
    executeWaitAkuma({
      path: root,
      ids: members.map((member) => member.id),
      completion: "all",
      signal: controller.signal,
      predicate: () => false,
    }),
    (error) => error === reason,
  );
  assert.equal(decodes, 3, "the failed member recomputes; its readable peer reuses");
});
