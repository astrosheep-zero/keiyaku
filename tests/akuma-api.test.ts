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
} from "../src/akuma/index.js";
import { ALLOWED_ACTIONS } from "../src/akuma/allowed.js";
import { AkumaHandle } from "../src/akuma/akuma-handle.js";
import { driveAkumaBody, type TellWakeRuntime } from "../src/akuma/body.js";
import { HeldAkumaLeash, initializeHeart, readTell, readTurn, recordTell } from "../src/akuma/heart/index.js";
import { allocateAkumaDirectory } from "../src/akuma/identity.js";
import { createProviderAttempt, type ProviderAdapter, type Session } from "../src/akuma/provider.js";
import type { OwnedProcess } from "../src/runtime/proc/run.js";
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

type FixtureSession = Omit<Session, "admission" | "forceDispose"> &
  Readonly<{ admission?: Session["admission"]; forceDispose?: Session["forceDispose"] }>;

function fixtureAttempt(input: Readonly<{ signal: AbortSignal }>, establish: () => Promise<FixtureSession>) {
  return createProviderAttempt(input.signal, async (custody) => {
    const fixture = await establish();
    const session: Session = {
      ...fixture,
      admission: fixture.admission ?? { fence: "api-fixture-turn" },
      forceDispose: fixture.forceDispose ?? fixture.abort,
    };
    let settleClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      settleClosed = resolve;
    });
    void session.completion.then(settleClosed, settleClosed);
    custody.own({
      closed,
      abort: async () => {
        await session.abort();
        settleClosed();
      },
      forceDispose: async () => {
        await session.forceDispose();
        settleClosed();
      },
    });
    return session;
  });
}

function answering(answer: string): ProviderAdapter {
  return {
    admitOptions(options) {
      return { kind: "admitted", options };
    },
    start(input) {
      return fixtureAttempt(input, async () => ({
        admission: { fence: "api-answer" },
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: "session" as const, coordinate: { sessionId: "api-session" } };
          },
        },
        completion: Promise.resolve({ kind: "answered" as const, answer, historyId: "api-history" }),
        async abort() {},
      }));
    },
  };
}

async function settleFixtureBodies(bodies: readonly Promise<unknown>[]): Promise<void> {
  await Promise.all(bodies.map((body) => body.catch(() => undefined)));
}

function fixtureRuntime(
  bodies: Promise<unknown>[],
  fixtures: ReadonlyMap<string, Readonly<{ adapter: ProviderAdapter; now: string }>>,
): TellWakeRuntime {
  return {
    async spawn(paths) {
      const fixture = fixtures.get(paths.directory);
      if (fixture === undefined) throw new Error(`missing fixture adapter for ${paths.directory}`);
      const body = driveAkumaBody({ paths }, fixture.adapter, { now: () => fixture.now });
      bodies.push(body);
      return {
        pid: 0,
        exited: body.then(
          () => ({ code: 0, signal: null, log: { path: paths.log, from: 0, to: 0 } }),
          () => ({ code: 1, signal: null, log: { path: paths.log, from: 0, to: 0 } }),
        ),
        async terminate() {},
        release() {},
      };
    },
  };
}

function installTellRuntime(runtime: TellWakeRuntime): () => void {
  const originalTell = AkumaHandle.prototype.tell;
  AkumaHandle.prototype.tell = function (body, tellId, recordedAt, existingRuntime, schemaJson) {
    return originalTell.call(this, body, tellId, recordedAt, existingRuntime ?? runtime, schemaJson);
  };
  return () => {
    AkumaHandle.prototype.tell = originalTell;
  };
}

async function bornWorld(root: string, suffix: string) {
  const world = await World.at(root);
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins: { square: { enabled: false } } }));
  const allocated = await allocateAkumaDirectory({ worldRoot: world, archetype: "claude", draw: () => suffix });
  await initializeHeart(allocated.paths);
  const holder = (await HeldAkumaLeash.try(allocated.paths))!;
  await holder.birth(allocated.paths, {
    id: allocated.id,
    archetype: "claude",
    provider: { name: "claude", kind: "claude-agent-sdk" },
    options: {},
    cwd: world,
    origin: { kind: "direct" },
    allowed: ALLOWED_ACTIONS,
    createdAt: "2026-08-10T00:00:00.000Z",
  });
  holder.release();
  return { world, allocated, akuma: Akuma.select(world, allocated.id) };
}

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
    let signalAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      signalAbort = resolve;
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
              yield { type: "session" as const, coordinate: { sessionId: "api-predecessor" } };
              await held;
            },
          },
          completion: held.then(() => ({ kind: "answered" as const, answer: '{"ok":true}', historyId: "hang" })),
          async abort() {
            signalAbort();
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
    while ((await readTell(allocated.paths, "seed"))?.binding === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
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
      await aborted;
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
