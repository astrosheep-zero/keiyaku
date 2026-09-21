import { fixtureAdapter } from "./support/akuma-tell.js";
import { temporaryDirectory } from "./support/process.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  Akuma,
  AkumaBusyError,
  AkumaDecodeError,
  AkumaProviderError,
  Schema,
  type AkumaIdleResult,
} from "../src/akuma/index.js";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import { driveAkumaBody, type TellWakeRuntime } from "../src/akuma/body.js";
import { readHeart, readTell, readTurn, recordTell, recordTellReceipt } from "../src/akuma/heart/index.js";
import { type ProviderAdapter } from "../src/akuma/provider.js";
import { executeTellWaitAkuma } from "../src/akuma/fleet-execution.js";
import { deferred, settlementProbe, waitForCondition } from "./support/process.js";
import { type InvokedAkumaCommand } from "../src/cli/commands/akuma.js";
import { invokeAkuma } from "../src/cli/commands/akuma-invoke.js";
import { schemaJsonText } from "../src/akuma/schema.js";
import { World } from "../src/world.js";

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
      "AkumaBusyError",
      "AkumaDecodeError",
      "AkumaNotBornError",
      "AkumaProviderError",
      "Schema",
    ].sort(),
  );
  assert.equal("AkumaHandle" in exported, false);
  assert.equal("TellResult" in exported, false);
});

test("package root exposes the same public Akuma values without private mechanisms", async () => {
  const subpath = await import("../src/akuma/index.js");
  const root: typeof subpath = await import("../src/index.js");
  for (const name of Object.keys(subpath) as Array<keyof typeof subpath>) {
    assert.strictEqual(root[name], subpath[name], name);
  }
  for (const name of ["AkumaHandle", "HeldAkumaLeash", "driveAkumaBody", "readHeart"]) {
    assert.equal(name in root, false, name);
  }
  const schema: import("../src/index.js").Schema<{ ok: boolean }> = root.Schema.zod(z.object({ ok: z.boolean() }));
  const options: import("../src/index.js").AkumaTellOptions<{ ok: boolean }> = { schema };
  assert.strictEqual(options.schema, schema);
  assert.deepEqual(schema.decode({ ok: true }), { ok: true });
});

test("Akuma.birth has no prompt and select is synchronous", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-birth-");
  const home = join(root, "home");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  const world = await World.at(root);
  const born = await Akuma.birth("worker", { root: world, home, cwd: root });
  const selected = Akuma.select(world, born.id);
  assert.equal(selected.id, born.id);
  assert.equal((await selected.status()).id, born.id);
  await born.idle();
  const page = await born.history();
  assert.equal(Array.isArray(page.rows), true);
  await born.kill();
});

import { answering, bornWorld, fixtureRuntime, installTellRuntime, settleFixtureBodies } from "./support/akuma-tell.js";

test("schema tell decodes JSON and typed failures stay distinct", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-schema-tell-"));
  const schema = Schema.zod(z.object({ ok: z.boolean() }).strict());
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const decoded = await bornWorld(root, "a1000002");
    fixtures.set(decoded.allocated.paths.directory, {
      adapter: answering('{"ok":true}'),
      now: "2026-08-10T00:00:01.000Z",
    });
    const value = await decoded.akuma.tell("structured", { schema });
    await settleFixtureBodies(bodies);
    assert.deepEqual(value, { ok: true });
    const fact = (await decoded.akuma.history()).rows.find((row) => row.kind === "tell");
    assert.equal(fact?.kind, "tell");
    if (fact?.kind === "tell") {
      const recorded = await readTell(decoded.allocated.paths, fact.tellId);
      assert.equal(recorded?.schemaJson, schemaJsonText(schema));
    }

    const invalid = await bornWorld(root, "a1000003");
    fixtures.set(invalid.allocated.paths.directory, {
      adapter: answering("not-json"),
      now: "2026-08-10T00:00:01.000Z",
    });
    await assert.rejects(invalid.akuma.tell("structured", { schema }), AkumaDecodeError);

    const mismatch = await bornWorld(root, "a1000004");
    fixtures.set(mismatch.allocated.paths.directory, {
      adapter: answering('{"ok":1}'),
      now: "2026-08-10T00:00:01.000Z",
    });
    await assert.rejects(mismatch.akuma.tell("structured", { schema }), AkumaDecodeError);

    const failed = await bornWorld(root, "a1000005");
    const failing: ProviderAdapter = fixtureAdapter(async () => ({
      admission: { fence: "api-fail" },
      events: {
        async *[Symbol.asyncIterator]() {
          yield { type: "session" as const, coordinate: { sessionId: "api-fail" } };
        },
      },
      completion: Promise.resolve({ kind: "failed" as const, diagnostic: "provider broke" }),
      async abort() {},
    }));
    fixtures.set(failed.allocated.paths.directory, { adapter: failing, now: "2026-08-10T00:00:01.000Z" });
    await assert.rejects(failed.akuma.tell("structured", { schema }), AkumaProviderError);
    await settleFixtureBodies(bodies);
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded Tell observes its exact admitted Turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wait-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const answered = await bornWorld(root, "a1000010");
    fixtures.set(answered.allocated.paths.directory, {
      adapter: answering("exact answer"),
      now: "2026-08-10T00:00:01.000Z",
    });
    const observed = await executeTellWaitAkuma({
      path: answered.world,
      id: answered.allocated.id,
      body: "answer this",
      timeoutMs: 1_000,
    });
    assert.equal(observed.tell.admission.tellId, observed.tell.row.tellId);
    assert.deepEqual(observed.observation, { reason: "answered", answer: "exact answer" });
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero window returns deadline without waiting for a delayed wake", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wait-late-wake-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const { allocated, world } = await bornWorld(root, "a1000018");
    const deliver = deferred<void>();
    fixtures.set(allocated.paths.directory, {
      adapter: fixtureAdapter(async () => {
        await deliver.promise;
        return {
          admission: { fence: "late-wake" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "late-wake" } };
            },
          },
          completion: Promise.resolve({ kind: "answered" as const, answer: "too late", historyId: "late-wake" }),
          async abort() {},
        };
      }),
      now: "2026-08-10T00:00:01.000Z",
    });
    // Safety net so a regressed implementation fails on the assertion, not by hanging.
    const forced = setTimeout(() => deliver.resolve(), 400);
    const startedAt = performance.now();
    const observed = await executeTellWaitAkuma({ path: world, id: allocated.id, body: "late", timeoutMs: 0 });
    const elapsed = performance.now() - startedAt;
    clearTimeout(forced);
    assert.deepEqual(observed.observation, { reason: "deadline" });
    assert.ok(elapsed < 200, `an expired window must not wait for delivery (waited ${elapsed}ms)`);
    assert.equal((await readTell(allocated.paths, observed.tell.admission.tellId))?.body, "late");
    deliver.resolve();
    await settleFixtureBodies(bodies);
    assert.equal((await readTell(allocated.paths, observed.tell.admission.tellId))?.state, "told");
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a waited schema Tell decodes at the CLI boundary and keeps decode failure distinct", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wait-schema-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const schemaPath = join(root, "answer.schema.json");
    writeFileSync(
      schemaPath,
      JSON.stringify({
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      }),
    );
    const answered = await bornWorld(root, "a1000013");
    fixtures.set(answered.allocated.paths.directory, {
      adapter: answering('{"ok":true}'),
      now: "2026-08-10T00:00:01.000Z",
    });
    const command: InvokedAkumaCommand = {
      command: "tell",
      akuma: answered.allocated.id,
      interrupt: false,
      schema: schemaPath,
      timeoutMs: 5_000,
      prompt: { kind: "argument", value: "structured" },
      output: "json",
    };
    const result = await invokeAkuma(command, { path: answered.world, environment: {}, readStdin: async () => "" });
    assert.equal(result.kind, "akuma");
    if (result.kind !== "akuma" || result.action !== "tell" || result.mode !== "wait")
      throw new Error("expected a waited Tell invocation result");
    assert.deepEqual(result.result.observation, { reason: "answered", answer: { ok: true } });

    const invalid = await bornWorld(root, "a1000014");
    fixtures.set(invalid.allocated.paths.directory, {
      adapter: answering("not-json"),
      now: "2026-08-10T00:00:01.000Z",
    });
    await assert.rejects(
      invokeAkuma(
        { ...command, akuma: invalid.allocated.id },
        { path: invalid.world, environment: {}, readStdin: async () => "" },
      ),
      AkumaDecodeError,
    );
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("waited Tell cancellation preserves its admission while the late Turn finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wait-cancel-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const { allocated, world } = await bornWorld(root, "a1000015");
    const started = deferred<void>();
    const finish = deferred<Readonly<{ kind: "answered"; answer: string; historyId: string }>>();
    fixtures.set(allocated.paths.directory, {
      adapter: fixtureAdapter(async () => ({
        admission: { fence: "waited-cancel" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "waited-cancel" } };
            started.resolve();
          },
        },
        completion: finish.promise,
        async abort() {},
      })),
      now: "2026-08-10T00:00:01.000Z",
    });
    const controller = new AbortController();
    const reason = new Error("stop observing the admitted Tell");
    const tellId = "waited-cancel-tell";
    const pending = executeTellWaitAkuma({
      path: world,
      id: allocated.id,
      body: "finish later",
      tellId,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await started.promise;
    await waitForCondition(
      "the admitted Tell to bind its Turn",
      async () => (await readTell(allocated.paths, tellId))?.binding !== undefined,
    );
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason);
    const admitted = await readTell(allocated.paths, tellId);
    assert.equal(admitted?.body, "finish later");
    assert.notEqual(admitted?.binding, undefined, "cancellation does not retract the admitted Tell");
    finish.resolve({ kind: "answered", answer: "late answer", historyId: "waited-cancel-history" });
    await settleFixtureBodies(bodies);
    const settled = await readTell(allocated.paths, tellId);
    assert.equal(settled?.state, "told");
    const turn = settled?.binding === undefined ? null : await readTurn(allocated.paths, settled.binding.turnSequence);
    assert.equal(turn?.end?.outcome.kind, "answered");
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero window observes an already-terminal Tell rather than the deadline", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wait-edge-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const { allocated, world } = await bornWorld(root, "a1000016");
    fixtures.set(allocated.paths.directory, { adapter: answering("edge answer"), now: "2026-08-10T00:00:01.000Z" });
    const handle = new AkumaHandle(allocated.id, world);
    const recordedAt = "2026-08-10T00:00:02.000Z";
    const recorded = await handle.tell("edge", undefined, recordedAt);
    await settleFixtureBodies(bodies);
    const observed = await handle.tellOutcome(recorded.admission.tellId, { timeoutMs: 0 });
    assert.equal(observed.reason, "completed", "a terminal result witnessed at the expired deadline wins");
    assert.equal(observed.outcome?.kind, "answered");
    if (observed.outcome?.kind === "answered") assert.equal(observed.outcome.answer, "edge answer");

    // The same expired edge through the full waited-Tell envelope never reports a deadline.
    restoreTellRuntime();
    const restoreStub = installTellRuntime({
      async spawn() {
        return { pid: 0, exited: new Promise(() => undefined), async terminate() {}, release() {} };
      },
    });
    try {
      const envelope = await executeTellWaitAkuma({
        path: world,
        id: allocated.id,
        body: "edge",
        tellId: recorded.admission.tellId,
        recordedAt,
        timeoutMs: 0,
      });
      assert.deepEqual(envelope.observation, { reason: "answered", answer: "edge answer" });
    } finally {
      restoreStub();
    }
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a terminal Tell delivery without a bound Turn observes an explicit unanswered result", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-wait-unanswered-"));
  const { allocated, world } = await bornWorld(root, "a1000017");
  const recordedAt = "2026-08-10T00:00:01.000Z";
  const tellId = "terminal-without-turn";
  await recordTell(allocated.paths, { kind: "tell", id: tellId, body: "gone", recordedAt });
  await recordTellReceipt(allocated.paths, { kind: "custody", evidence: "exact", tellId, receivedAt: recordedAt });
  const restoreTellRuntime = installTellRuntime({
    async spawn() {
      return { pid: 0, exited: new Promise(() => undefined), async terminate() {}, release() {} };
    },
  });
  try {
    const observed = await executeTellWaitAkuma({
      path: world,
      id: allocated.id,
      body: "gone",
      tellId,
      recordedAt,
      timeoutMs: 0,
    });
    assert.equal(observed.tell.row.state, "told");
    assert.deepEqual(observed.observation, { reason: "unanswered" });
  } finally {
    restoreTellRuntime();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded interrupt Tell preserves the existing provider-unavailable error", async (context) => {
  const { allocated, world } = await bornWorld(temporaryDirectory(context, "keiyaku-akuma-api-tell-wait-interrupt-"), "a1000012");
  context.mock.method(AkumaHandle.prototype, "admitInterrupt", async () => ({ kind: "unavailable" as const, evidence: "hung" as const }));
  await assert.rejects(
    executeTellWaitAkuma({ path: world, id: allocated.id, body: "interrupt", timeoutMs: 0, interrupt: true }),
    (error) => error instanceof AkumaProviderError && error.message === "Tell interrupt unavailable: hung",
  );
});

test("schema tell routes admission and preserves typed refusals without launching a Body", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-routing-");
  const akuma = Akuma.select(await World.at(root), "aku/claude/a1000006");
  const schema = Schema.zod(z.object({ ok: z.boolean() }).strict());
  const busy = new AkumaBusyError();
  const tells: Parameters<AkumaHandle["tell"]>[] = [];
  const interrupts: Parameters<AkumaHandle["interrupt"]>[] = [];
  context.mock.method(AkumaHandle.prototype, "tell", async (...args: Parameters<AkumaHandle["tell"]>) => {
    tells.push(args);
    throw busy;
  });
  context.mock.method(AkumaHandle.prototype, "interrupt", async (...args: Parameters<AkumaHandle["interrupt"]>) => {
    interrupts.push(args);
    return { kind: "unavailable", evidence: "hung" } as const;
  });

  // The API owns routing/translation; Heart and control suites own real busy/leash behavior.
  await assert.rejects(akuma.tell("default", { schema }), (error) => error === busy);
  await assert.rejects(
    akuma.tell("explicit", { schema, interrupt: false, initiator: "api-caller" }),
    (error) => error === busy,
  );
  assert.equal(interrupts.length, 0);
  assert.equal(tells.length, 2);
  for (const [index, args] of tells.entries()) {
    assert.equal(args[0], index === 0 ? "default" : "explicit");
    assert.match(args[1]!, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(args.slice(2), [
      undefined,
      undefined,
      { schemaJson: schemaJsonText(schema), ...(index === 0 ? {} : { initiator: "api-caller" }) },
    ]);
  }
  await assert.rejects(akuma.tell("interrupt", { schema, interrupt: true, initiator: "api-caller" }), {
    name: "AkumaProviderError",
    message: "schema interrupt unavailable: hung",
  });
  assert.equal(tells.length, 2);
  assert.equal(interrupts.length, 1);
  const [body, options] = interrupts[0]!;
  assert.equal(body, "interrupt");
  assert.match(options!.tellId!, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(options, {
    tellId: options!.tellId,
    schemaJson: schemaJsonText(schema),
    initiator: "api-caller",
  });
  assert.equal(new Set([...tells.map((args) => args[1]), options!.tellId]).size, 3);
});

test("schema interrupt carries caller cancellation into its held control admission", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-schema-interrupt-cancel-");
  const akuma = Akuma.select(await World.at(root), "aku/claude/a1000007");
  const schema = Schema.zod(z.object({ ok: z.boolean() }).strict());
  const controller = new AbortController();
  const reason = new Error("cancel held schema interrupt");
  let received: AbortSignal | undefined;
  context.mock.method(AkumaHandle.prototype, "interrupt", async (...args: Parameters<AkumaHandle["interrupt"]>) => {
    const options = args[1];
    assert.ok(options);
    received = options.signal;
    return await new Promise<never>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
  });
  const pending = akuma.tell("interrupt", { schema, interrupt: true, signal: controller.signal });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  assert.strictEqual(received, controller.signal);
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
      async abort() {
        release?.();
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

test("idle timeout with a pending tell reports pendingTell", async (context) => {
  const root = temporaryDirectory(context, "keiyaku-akuma-api-idle-pending-");
  const { allocated, akuma } = await bornWorld(root, "a1000010");
  await recordTell(allocated.paths, {
    kind: "tell",
    id: "queued",
    body: "later",
    recordedAt: "2026-08-10T00:00:01.000Z",
  });
  const timed = await akuma.idle({ timeoutMs: 100 });
  assert.equal(timed.reason, "deadline");
  assert.equal(timed.status.id, allocated.id);
});
