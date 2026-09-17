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
  AkumaNotBornError,
  AkumaProviderError,
  Schema,
  type AkumaIdleResult,
} from "../src/akuma/index.js";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { driveAkumaBody } from "../src/akuma/body.js";
import { initializeHeart, readTell, readTurn, recordTell } from "../src/akuma/heart/index.js";
import { type ProviderAdapter } from "../src/akuma/provider.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
import { settlementProbe, waitForCondition } from "./support/process.js";
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

test("Akuma.birth has no prompt and select is synchronous", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-birth-"));
  const home = join(root, "home");
  mkdirSync(join(home, "akuma"), { recursive: true });
  writeFileSync(join(home, "akuma", "worker.md"), "---\nprovider: claude\n---\nWork.\n");
  try {
    const world = await World.at(root);
    const born = await Akuma.birth("worker", { root: world, home, cwd: root });
    const selected = Akuma.select(world, born.id);
    assert.equal(selected.id, born.id);
    assert.equal((await selected.status()).id, born.id);
    await born.idle();
    const page = await born.history();
    assert.equal(Array.isArray(page.rows), true);
    await born.kill();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import {
  answering,
  bornWorld,
  fixtureAttempt,
  fixtureRuntime,
  installTellRuntime,
  settleFixtureBodies,
} from "./support/akuma-tell.js";

test("plain tell returns the answer and binds an exact TellId", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-tell-"));
  const bodies: Promise<unknown>[] = [];
  const fixtures = new Map<string, Readonly<{ adapter: ProviderAdapter; now: string }>>();
  const restoreTellRuntime = installTellRuntime(fixtureRuntime(bodies, fixtures));
  try {
    const { allocated, akuma } = await bornWorld(root, "a1000001");
    fixtures.set(allocated.paths.directory, { adapter: answering("plain answer"), now: "2026-08-10T00:00:01.000Z" });
    const answered = await akuma.tell("hello");
    await settleFixtureBodies(bodies);
    assert.equal(answered, "plain answer");
    const page = await akuma.history();
    const tell = page.rows.find((row) => row.kind === "tell");
    assert.equal(tell?.kind, "tell");
    if (tell?.kind === "tell") {
      const fact = await readTell(allocated.paths, tell.tellId);
      assert.equal(fact?.id, tell.tellId);
      assert.equal(fact?.body, "hello");
      assert.notEqual(fact?.binding, undefined);
    }
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

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
    const failing: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start(input) {
        return fixtureAttempt(input, async () => ({
          admission: { fence: "api-fail" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "api-fail" } };
            },
          },
          completion: Promise.resolve({ kind: "failed" as const, diagnostic: "provider broke" }),
          async abort() {},
        }));
      },
    };
    fixtures.set(failed.allocated.paths.directory, { adapter: failing, now: "2026-08-10T00:00:01.000Z" });
    await assert.rejects(failed.akuma.tell("structured", { schema }), AkumaProviderError);
    await settleFixtureBodies(bodies);
  } finally {
    restoreTellRuntime();
    await settleFixtureBodies(bodies);
    rmSync(root, { recursive: true, force: true });
  }
});

test("schema tell on a running Body is busy unless interrupt is set", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-busy-"));
  const schema = Schema.zod(z.object({ ok: z.boolean() }).strict());
  let release: (() => void) | undefined;
  let body: Promise<unknown> | undefined;
  let successorBody: Promise<unknown> | undefined;
  try {
    const { allocated, akuma } = await bornWorld(root, "a1000006");
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let abortObserved = false;
    const hanging: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start(input) {
        return fixtureAttempt(input, async () => ({
          admission: { fence: "api-hang" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "api-predecessor" } };
              await held;
            },
          },
          completion: held.then(() => ({ kind: "answered" as const, answer: '{"ok":true}', historyId: "hang" })),
          async abort() {
            abortObserved = true;
          },
        }));
      },
    };
    await recordTell(allocated.paths, {
      kind: "tell",
      id: "seed",
      body: "start",
      recordedAt: "2026-08-10T00:00:01.000Z",
    });
    body = driveAkumaBody({ paths: allocated.paths }, hanging, { now: () => "2026-08-10T00:00:02.000Z" });
    await waitForSeedBinding(allocated.paths, body);
    await assert.rejects(akuma.tell("structured", { schema }), AkumaBusyError);
    const successor: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start(input) {
        return fixtureAttempt(input, async () => ({
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "api-successor" } };
            },
          },
          completion: Promise.resolve({ kind: "answered" as const, answer: "not-json", historyId: "successor" }),
          async abort() {},
        }));
      },
      resume(input) {
        return fixtureAttempt(input, async () => ({
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "api-successor" } };
            },
          },
          completion: Promise.resolve({ kind: "answered" as const, answer: "not-json", historyId: "successor" }),
          async abort() {},
        }));
      },
    };
    const runtime = {
      async spawn(paths: typeof allocated.paths): Promise<OwnedProcess> {
        successorBody = driveAkumaBody({ paths }, successor, { now: () => "2026-08-10T00:00:03.000Z" });
        return {
          pid: 0,
          exited: successorBody.then(() => ({ code: 0, signal: null, log: { path: paths.log, from: 0, to: 0 } })),
          async terminate() {},
          release() {},
        };
      },
    };
    const originalInterrupt = AkumaHandle.prototype.interrupt;
    AkumaHandle.prototype.interrupt = function (body, options) {
      return originalInterrupt.call(this, body, { ...options, runtime });
    };
    try {
      const interrupting = akuma.tell("structured", { schema, interrupt: true });
      await waitForCondition(
        "the predecessor provider abort callback that releases the held completion",
        () => abortObserved,
        {
          terminalState: settlementProbe(
            interrupting,
            (settled) =>
              `the interrupt Tell settled with decoded ${JSON.stringify(settled)} before the predecessor provider aborted`,
          ),
        },
      );
      release?.();
      release = undefined;
      await assert.rejects(interrupting, AkumaDecodeError);
      const tell = (await akuma.history()).rows.find((row) => row.kind === "tell" && row.text === "structured");
      assert.equal(tell?.kind, "tell");
      if (tell?.kind === "tell") {
        const fact = await readTell(allocated.paths, tell.tellId);
        assert.notEqual(fact?.binding, undefined);
        if (fact?.binding !== undefined) {
          const turn = await readTurn(allocated.paths, fact.binding.turnSequence);
          const outcome = turn?.end?.outcome;
          assert.equal(outcome?.kind, "invalid-output");
          if (outcome?.kind === "invalid-output") assert.equal(outcome.answer, "not-json");
        }
      }
    } finally {
      AkumaHandle.prototype.interrupt = originalInterrupt;
    }
    await body;
    await successorBody;
    await akuma.idle();
  } finally {
    release?.();
    await body?.catch(() => undefined);
    await successorBody?.catch(() => undefined);
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
    assert.equal(settled.kind, "idle");
    if (settled.kind !== "idle") return;
    assert.equal(settled.reason, "asleep");
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
    const hanging: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start(input) {
        return fixtureAttempt(input, async () => ({
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
      },
    };
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
    assert.equal(killed.kind, "idle");
    if (killed.kind !== "idle") return;
    assert.equal(killed.reason, "killed");
    assert.equal(killed.status.life, "killed");
    assert.equal(killed.status.id, allocated.id);
  } finally {
    release?.();
    await body?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle timeout names the outstanding conditions with the final status", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-idle-timeout-"));
  let release: (() => void) | undefined;
  let body: Promise<unknown> | undefined;
  try {
    const { allocated, akuma } = await bornWorld(root, "a1000009");
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hanging: ProviderAdapter = {
      admitOptions(options) {
        return { kind: "admitted", options };
      },
      start(input) {
        return fixtureAttempt(input, async () => ({
          admission: { fence: "api-hang" },
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "session" as const, coordinate: { sessionId: "api-idle-hang" } };
              await held;
            },
          },
          completion: held.then(() => ({ kind: "answered" as const, answer: "late", historyId: "hang" })),
          async abort() {},
        }));
      },
    };
    await recordTell(allocated.paths, {
      kind: "tell",
      id: "seed",
      body: "start",
      recordedAt: "2026-08-10T00:00:01.000Z",
    });
    body = driveAkumaBody({ paths: allocated.paths }, hanging, { now: () => "2026-08-10T00:00:02.000Z" });
    await waitForSeedBinding(allocated.paths, body);
    const timed = await akuma.idle({ timeoutMs: 100 });
    assert.equal(timed.kind, "timeout");
    if (timed.kind !== "timeout") return;
    assert.deepEqual(timed.reason, { running: true, pendingTell: false });
    assert.equal(timed.status.life, "running");
    assert.equal(timed.status.id, allocated.id);
  } finally {
    release?.();
    await body?.catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle timeout with a pending tell reports pendingTell", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-idle-pending-"));
  try {
    const { allocated, akuma } = await bornWorld(root, "a1000010");
    await recordTell(allocated.paths, {
      kind: "tell",
      id: "queued",
      body: "later",
      recordedAt: "2026-08-10T00:00:01.000Z",
    });
    const timed = await akuma.idle({ timeoutMs: 100 });
    assert.equal(timed.kind, "timeout");
    if (timed.kind !== "timeout") return;
    assert.deepEqual(timed.reason, { running: false, pendingTell: true });
    assert.equal(timed.status.id, allocated.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("select of an unborn id refuses tell without durable input", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-akuma-api-unborn-"));
  try {
    const world = await World.at(root);
    const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => "a1000007" });
    await initializeHeart(allocated.paths);
    const akuma = Akuma.select(world, allocated.id);
    await assert.rejects(akuma.tell("future"), AkumaNotBornError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
