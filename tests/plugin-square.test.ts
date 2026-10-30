import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Square, harnessOwner, type Activity, type ActivityMetadata, type Owner } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import { squareSeat } from "../src/cli/square-identity.js";
import type { PluginHooks } from "../src/plugin/public.js";
import type { WorldRoot } from "../src/world.js";
import { deferred as promiseBarrier, restoreEnvironmentValues } from "./support/process.js";

const testIndexRoot = mkdtempSync(join(tmpdir(), "keiyaku-square-index-"));
const previousIndex = process.env.SQUARE_INDEX;
process.env.SQUARE_INDEX = join(testIndexRoot, "index.ndjsonl");
after(() => {
  restoreEnvironmentValues({ SQUARE_INDEX: previousIndex });
  rmSync(testIndexRoot, { recursive: true, force: true });
});

const squarePath = (root: string): string => join(root, ".square", "KEIYAKU.square");
// One World-local notifier authors every outcome and abnormal Body notice.
const NOTIFIER = "keiyaku-notice";
const NOTIFIER_SESSION = "keiyaku:square-notifier";
const NOTIFIER_CHANNEL = "unknown";
const notifierOwner: Owner = harnessOwner({ channel: NOTIFIER_CHANNEL, session: NOTIFIER_SESSION });
const squarePrototype = Object.getPrototypeOf(Square.inMemory({ markdown: "" })) as Square;
const legacyPiName = (session: string): string => `pi-${createHash("sha256").update(session).digest("hex").slice(0, 12)}`;

function activateSquare(world: string): ReturnType<typeof squarePlugin.activate> {
  return squarePlugin.activate({
    world: world as WorldRoot,
    config: undefined,
    writablePath: () => join(world, ".square"),
  });
}

// The Square plugin reads process.env directly, so the surrounding harness must not
// be able to contribute a caller identity the fixture did not choose.
const SESSION_IDENTITY_VARIABLE = /_SESSION_ID$|_THREAD_ID$|^PASEO_AGENT_ID$|^SQUARE_PARTICIPANT_NAME$/u;

function ambientSessionIdentity(): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => SESSION_IDENTITY_VARIABLE.test(name))
      .map((name) => [name, process.env[name]]),
  );
}

async function expressions(
  path: string,
): Promise<readonly Readonly<{ actor: string; body: string; mentions: readonly string[] }>[]> {
  const square = await Square.at({ path });
  try {
    return (await square.history({ limit: null })).activities.flatMap((activity) =>
      activity.kind === "say" && activity.body !== undefined
        ? [{
            actor: activity.actor,
            body: activity.body,
            mentions: activity.mentions ?? [],
            ...(activity.metadata === undefined ? {} : { metadata: activity.metadata }),
          }]
        : [],
    );
  } finally {
    await square.close();
  }
}

type BodyEndDetails = Omit<Parameters<NonNullable<PluginHooks["akuma.body-ended"]>>[0], "kind">;
type CapturedExpression = Readonly<{ actor: string; body: string; mentions: readonly string[]; metadata?: ActivityMetadata }>;
type HeldExpression = Readonly<{ sent: Promise<void>; release: () => void }>;

const captured = (
  actor: string,
  body: string,
  mentions: readonly string[] = [],
  metadata?: ActivityMetadata,
): CapturedExpression => ({ actor, body, mentions, ...(metadata === undefined ? {} : { metadata }) });
const outcome = (body: string, mentions: readonly string[] = []): CapturedExpression =>
  captured(NOTIFIER, body, mentions);
const turnOutcome = (body: string, akumaId: string, sequence: number, mentions: readonly string[] = []): CapturedExpression =>
  captured(NOTIFIER, body, mentions, {
    keiyaku: { kind: "akuma.turn-outcome", akumaId, historyId: `turn/${sequence}` },
  });
const optionalInitiator = (initiator: string | undefined): { initiator?: string } => (initiator === undefined ? {} : { initiator });
const optionalDiagnostic = (diagnostic: string | undefined): { diagnostic?: string } => (diagnostic === undefined ? {} : { diagnostic });
async function withHeldSquareExpression<T>(
  akumaId: string,
  callback: (barrier: HeldExpression) => Promise<T>,
  holdAfterSend = true,
): Promise<T> {
  // The shared notifier authors every send, so the subject Akuma survives only
  // in the expression's envelope; hold exactly that send.
  const originalJoin = squarePrototype.join;
  const { promise: sent, resolve: markSent } = promiseBarrier<void>();
  const { promise: released, resolve: release } = promiseBarrier<void>();
  squarePrototype.join = async function (...arguments_: Parameters<typeof originalJoin>) {
    const joined = await originalJoin.call(this, ...arguments_);
    const express = joined.participant.express.bind(joined.participant);
    return {
      ...joined,
      participant: {
        ...joined.participant,
        express: (async (...expressArguments: unknown[]) => {
          const send = () => Reflect.apply(express, undefined, expressArguments) as ReturnType<typeof express>;
          const input = expressArguments[0];
          const body = typeof input === "string"
            ? input
            : typeof input === "object" && input !== null && "body" in input && typeof input.body === "string"
              ? input.body
              : undefined;
          if (body === undefined ||
              (!body.startsWith(`✓ ${akumaId} came back\n`) && !body.startsWith(`× ${akumaId} came back\n`))) {
            return send();
          }
          if (!holdAfterSend) {
            markSent();
            await released;
          }
          const result = await send();
          if (holdAfterSend) {
            markSent();
            await released;
          }
          return result;
        }) as typeof express,
      },
    };
  };
  try {
    return await callback({ sent, release });
  } finally {
    release();
    squarePrototype.join = originalJoin;
  }
}
type SquareNotificationFixture = Readonly<{
  admit(initiator: string): Promise<void>;
  report(signal: Parameters<NonNullable<PluginHooks["akuma.reported"]>>[0]): Promise<void>;
  failedTurn(
    akumaId: string,
    bodySequence: number,
    turnSequence: number,
    initiator: string | undefined,
    reason: string,
    cancellation?: AbortSignal,
    participants?: readonly string[],
    contractId?: string,
  ): Promise<void>;
  canceledTurn(akumaId: string, bodySequence: number, turnSequence: number, initiator: string): Promise<void>;
  answeredTurn(
    akumaId: string,
    bodySequence: number,
    turnSequence: number,
    initiator: string | undefined,
    text: string,
    cancellation?: AbortSignal,
    participants?: readonly string[],
    contractId?: string,
  ): Promise<void>;
  bodyEnd(
    akumaId: string,
    bodySequence: number,
    end: BodyEndDetails["end"],
    initiator?: string,
    diagnostic?: string,
    cancellation?: AbortSignal,
    participants?: readonly string[],
  ): Promise<void>;
  expressions(): Promise<readonly CapturedExpression[]>;
  bodies(): Promise<readonly string[]>;
  observe(akumaId: string, historyId: string, observer?: string, cancellation?: AbortSignal): Promise<void>;
  square<T>(operation: (square: Square) => Promise<T>): Promise<T>;
  owner: Owner;
  withHeldExpression<T>(
    akumaId: string,
    callback: (barrier: HeldExpression) => Promise<T>,
    holdAfterSend?: boolean,
  ): Promise<T>;
}>;

async function withSquareNotificationFixture<T>(
  name: string,
  callback: (fixture: SquareNotificationFixture) => Promise<T>,
  initiators?: readonly string[],
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), `keiyaku-square-${name}-`));
  const prior = { ...ambientSessionIdentity(), SQUARE_INDEX: process.env.SQUARE_INDEX };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  process.env.PI_SESSION_ID = `fixture-${name}`;
  process.env.SQUARE_INDEX = join(root, "index.ndjsonl");
  const fixtureEnvironment = { ...process.env };
  const fixtureOwner: Owner = harnessOwner({ channel: "pi", session: fixtureEnvironment.PI_SESSION_ID! });
  try {
    mkdirSync(join(root, ".square"), { recursive: true });
    const instance = await activateSquare(root);
    const turn = instance.signals?.["akuma.turn-outcome"];
    const bodyEnd = instance.signals?.["akuma.body-ended"];
    const initiating = instance.signals?.["akuma.initiating"];
    const report = instance.signals?.["akuma.reported"];
    const observed = instance.signals?.["akuma.outcome-observed"];
    assert.ok(observed);
    assert.ok(turn);
    assert.ok(bodyEnd);
    assert.ok(initiating);
    assert.ok(report);
    const fixture: SquareNotificationFixture = {
      async report(signal) { await report(signal); },
      async admit(initiator) {
        await initiating({ kind: "akuma.initiating", initiator });
      },
      async failedTurn(akumaId, bodySequence, turnSequence, initiator, reason, cancellation, participants, contractId) {
        await turn(
          {
            kind: "akuma.turn-outcome",
            akumaId,
            bodySequence,
            turnSequence,
            ...optionalInitiator(initiator),
            ...(participants === undefined && initiator === undefined ? {} : { participants: participants ?? [initiator!] }),
            ...(contractId === undefined ? {} : { contractId }),
            outcome: { kind: "failed", reason },
          },
          cancellation,
        );
      },
      async canceledTurn(akumaId, bodySequence, turnSequence, initiator) {
        await turn({ kind: "akuma.turn-outcome", akumaId, bodySequence, turnSequence,
          initiator, participants: [initiator], outcome: { kind: "canceled" } });
      },
      async answeredTurn(akumaId, bodySequence, turnSequence, initiator, text, cancellation, participants, contractId) {
        await turn(
          {
            kind: "akuma.turn-outcome",
            akumaId,
            bodySequence,
            turnSequence,
            ...optionalInitiator(initiator),
            ...(participants === undefined && initiator === undefined ? {} : { participants: participants ?? [initiator!] }),
            ...(contractId === undefined ? {} : { contractId }),
            outcome: { kind: "answered", text },
          },
          cancellation,
        );
      },
      async bodyEnd(akumaId, bodySequence, end, initiator, diagnostic, cancellation, participants) {
        await bodyEnd(
          {
            kind: "akuma.body-ended",
            akumaId,
            bodySequence,
            end,
            ...optionalInitiator(initiator),
            ...(participants === undefined && initiator === undefined ? {} : { participants: participants ?? [initiator!] }),
            ...optionalDiagnostic(diagnostic),
          },
          cancellation,
        );
      },
      async observe(akumaId, historyId, observer, cancellation) {
        // Select an already-owned voice using its actual fixture session.
        const savedName = process.env.SQUARE_PARTICIPANT_NAME;
        if (observer === undefined) delete process.env.SQUARE_PARTICIPANT_NAME;
        else process.env.SQUARE_PARTICIPANT_NAME = observer;
        let selected;
        try { selected = await activateSquare(root); }
        finally { restoreEnvironmentValues({ SQUARE_PARTICIPANT_NAME: savedName }); }
        await selected.signals?.["akuma.outcome-observed"]?.({ kind: "akuma.outcome-observed", akumaId, historyId }, cancellation);
      },
      async square(operation) {
        const square = await Square.at({ path: squarePath(root), env: fixtureEnvironment });
        try { return await operation(square); } finally { await square.close(); }
      },
      expressions: () => expressions(squarePath(root)),
      async bodies() {
        return (await expressions(squarePath(root))).map(({ body }) => body);
      },
      withHeldExpression: withHeldSquareExpression,
      owner: fixtureOwner,
    };
    for (const initiator of initiators ?? ["Alice", "Bob"]) await fixture.admit(initiator);
    return await callback(fixture);
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
}

test("Square reports address only the opening initiator and survive outcome observation", async () => {
  await withSquareNotificationFixture("report", async (fixture) => {
    const signal = {
      kind: "akuma.reported" as const, akumaId: "aku/report", bodySequence: 2,
      turnSequence: 3, reportSequence: 7, text: "Progress\n@Bob\n\nexact text",
      at: "2026-10-30T00:00:00.000Z", initiator: "Alice",
    };
    await fixture.report(signal);
    const { initiator: _initiator, ...anonymous } = signal;
    await fixture.report(anonymous);
    assert.deepEqual(await fixture.expressions(), [captured(
      NOTIFIER, "aku/report report/7 (body/2, turn/3)\n\nProgress\n@Bob\n\nexact text", ["Alice"],
      { keiyaku: { kind: "akuma.reported", akumaId: "aku/report", bodySequence: 2,
        turnSequence: 3, reportSequence: 7, at: signal.at } },
    )]);
    await fixture.observe("aku/report", "turn/3", "Alice");
    await fixture.square(async (square) => {
      const notice = (await square.history({ from: [NOTIFIER], limit: null })).activities.find(a => a.kind === "say")!;
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered("Alice", notice.id), false);
      assert.equal(snapshot.delivered("Bob", notice.id), false);
    });
  });
});

function isMetadataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTurnNotice(activity: Activity, akumaId: string, sequence: number): boolean {
  const identity = activity.metadata?.keiyaku;
  return activity.kind === "say" && activity.actor === NOTIFIER && isMetadataRecord(identity) &&
    identity.kind === "akuma.turn-outcome" && identity.akumaId === akumaId && identity.historyId === `turn/${sequence}`;
}
async function outcomeNotice(fixture: SquareNotificationFixture, akumaId: string, sequence: number): Promise<Activity> {
  const found = await fixture.square(async (square) =>
    (await square.history({ from: [NOTIFIER], limit: null })).activities.find((activity) =>
      isTurnNotice(activity, akumaId, sequence),
    ),
  );
  assert.ok(found !== undefined, `expected the structured Turn notice for ${akumaId} turn/${sequence}`);
  return found;
}

async function waitScopeFixture(t: TestContext, participant: object) {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-lease-lifetime-"));
  const prior = { ...ambientSessionIdentity(), PI_SESSION_ID: process.env.PI_SESSION_ID };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  process.env.PI_SESSION_ID = "requester-fixture";
  t.after(() => { restoreEnvironmentValues(prior); rmSync(root, { recursive: true, force: true }); });
  let closes = 0;
  t.mock.method(Square, "at", async () => ({
    seatsOf: async () => [{ name: "Requester", generation: "act/1", attachment: "attached" }],
    participant: async () => participant,
    close: async () => { closes++; },
  }) as unknown as Square);
  const instance = await activateSquare(root);
  assert.ok(instance.waitDeferral);
  return { acquire: instance.waitDeferral, closes: () => closes };
}

test("partial Square acquisition keeps late peer custody and preserves its original failure", async (t) => {
  const { promise: bothStarted, resolve: started } = promiseBarrier<void>();
  const { promise: finishPeer, resolve: finish } = promiseBarrier<void>();
  const original = new Error("second acquisition failed");
  const released: string[] = [];
  let attempts = 0;
  const fixture = await waitScopeFixture(t, {
    async deferDelivery() {
      if (++attempts === 2) { started(); throw original; }
      await finishPeer;
      return { id: "own-lease" };
    },
    async renewDeliveryDeferral() { assert.fail("partial acquisition must not start renewal"); },
    async releaseDeliveryDeferral(id: string, { signal }: { signal: AbortSignal }) {
      assert.equal(signal.aborted, false, "partial cleanup uses fresh cancellation");
      released.push(id);
      throw new Error("release failed");
    },
  });
  const pending = assert.rejects(Promise.resolve(fixture.acquire({ akumaIds: ["aku/one", "aku/two"] })), error => error === original);
  await bothStarted;
  assert.deepEqual(released, []);
  finish();
  await pending;
  assert.deepEqual(released, ["own-lease"]);
  assert.equal(fixture.closes(), 1);
});

test("Square renewal recovers transient diagnostics, retains proven loss, and closes without overlap or stranded leases", async (t) => {
  const { promise: firstBatch, resolve: finishFirst } = promiseBarrier<void>();
  const { promise: firstStarted, resolve: startedFirst } = promiseBarrier<void>();
  const { promise: nextStarted, resolve: startedNext } = promiseBarrier<void>();
  let acquired = 0;
  let renewals = 0;
  let recovering = true;
  const renewedIds: string[] = [];
  const released: string[] = [];
  const fixture = await waitScopeFixture(t, {
    async deferDelivery() { return { id: `own-${++acquired}` }; },
    async renewDeliveryDeferral(id: string, _duration: number, { signal }: { signal: AbortSignal }) {
      const attempt = ++renewals;
      renewedIds.push(id);
      if (recovering) {
        if (attempt === 1) throw new Error("temporary renewal failure");
        return {};
      }
      if (attempt === 2) startedFirst();
      if (attempt === 4) startedNext();
      if (attempt <= 2) { await firstBatch; return id === "own-1" ? null : {}; }
      if (attempt === 3) return {};
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    async releaseDeliveryDeferral(id: string, { signal }: { signal: AbortSignal }) {
      assert.equal(signal.aborted, false);
      released.push(id);
      return true;
    },
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const recovered = await fixture.acquire({ akumaIds: ["aku/one", "aku/two"] });
  assert.ok(recovered);
  t.mock.timers.tick(120_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(renewals, 2);
  t.mock.timers.tick(120_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(renewals, 4);
  await recovered.close();
  assert.deepEqual(released.sort(), ["own-1", "own-2"], "recovered renewal closes cleanly and releases both leases");
  assert.equal(fixture.closes(), 1);
  recovering = false;
  acquired = renewals = 0;
  renewedIds.length = released.length = 0;
  const scope = await fixture.acquire({ akumaIds: ["aku/one", "aku/two"] });
  assert.ok(scope);
  t.mock.timers.tick(120_000);
  await firstStarted;
  t.mock.timers.tick(120_000);
  assert.equal(renewals, 2, "a pending batch never schedules an overlapping renewal");
  finishFirst();
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(120_000);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(renewedIds, ["own-1", "own-2", "own-2"], "only the still-live lease renews after proven loss");
  t.mock.timers.tick(120_000);
  await nextStarted;
  const closing = scope.close();
  assert.equal(scope.close(), closing, "repeat close shares the same cleanup");
  await assert.rejects(Promise.resolve(closing), /expired before renewal/u);
  assert.deepEqual(released.sort(), ["own-1", "own-2"]);
  assert.equal(fixture.closes(), 2);
  t.mock.timers.tick(600_000);
  assert.equal(renewals, 4, "close leaves no renewal timer or detached batch");
});

test("wait scopes defer only the requester's selected Turn notices, acknowledge exactly, and release independently", {
  skip: process.platform === "win32" ? "the queue fixture is a POSIX executable" : false,
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-wait-"));
  const prior = { ...ambientSessionIdentity(),
    SQUARE_CODEX_BIN: process.env.SQUARE_CODEX_BIN, SQUARE_CODEX_QUEUE_LOG: process.env.SQUARE_CODEX_QUEUE_LOG,
    SQUARE_CODEX_BOUNDARIES: process.env.SQUARE_CODEX_BOUNDARIES, SQUARE_INDEX: process.env.SQUARE_INDEX,
  };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  const scopes: { close(signal?: AbortSignal): Promise<void> | void }[] = [];
  try {
    mkdirSync(join(root, ".square"), { recursive: true });
    const log = join(root, "queue.jsonl");
    const bin = join(root, "codex-fixture");
    writeFileSync(bin, '#!/usr/bin/env node\nrequire("node:fs").appendFileSync(process.env.SQUARE_CODEX_QUEUE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");');
    chmodSync(bin, 0o755);
    process.env.SQUARE_CODEX_BIN = bin;
    process.env.SQUARE_CODEX_QUEUE_LOG = log;
    process.env.SQUARE_CODEX_BOUNDARIES = join(root, "boundaries.json");
    process.env.SQUARE_INDEX = join(root, "index.ndjsonl");
    process.env.CODEX_THREAD_ID = "requester";
    process.env.SQUARE_PARTICIPANT_NAME = "Alice";
    const env = { ...process.env };
    const requesterOwner = harnessOwner({ channel: "codex", session: "requester" });
    const square = await Square.build({ path: squarePath(root), markdown: "", env });
    const alice = (await square.join("Alice", {
      owner: requesterOwner,
      wakeAddress: { kind: "codex-queue", address: { threadId: "requester" } },
    })).participant;
    const peer = await Square.at({ path: squarePath(root), env });
    try {
      await peer.join("Bob", {
        owner: harnessOwner({ channel: "codex", session: "other-recipient" }),
        wakeAddress: { kind: "codex-queue", address: { threadId: "other-recipient" } },
      });
      writeFileSync(process.env.SQUARE_CODEX_BOUNDARIES, JSON.stringify({ v: 1, nextSequence: 1, threads: {
        requester: { lastStop: 1, lastNonStop: 0 }, "other-recipient": { lastStop: 1, lastNonStop: 0 },
      } }));
      const instance = await activateSquare(root);
      assert.ok(instance.waitDeferral);
      const first = await instance.waitDeferral({ akumaIds: ["aku/one", "aku/two"] });
      if (first === undefined) {
        assert.equal("deferDelivery" in alice, false, "only the published missing capability permits a no-op");
        t.diagnostic("published Square: wait deferral capability absent, graceful no-op verified");
        return;
      }
      scopes.push(first);
      const second = await instance.waitDeferral({ akumaIds: ["aku/one"] });
      assert.ok(second);
      scopes.push(second);
      const queues = (): string[][] => existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
      await instance.signals?.["akuma.reported"]?.({ kind: "akuma.reported", akumaId: "aku/one",
        bodySequence: 1, turnSequence: 1, reportSequence: 1, text: "progress", at: "2026-10-30T00:00:00Z",
        initiator: "Alice" });
      assert.deepEqual(queues().map(args => args[2]), ["requester"], "a report wakes through an active Turn deferral");
      writeFileSync(log, "");
      const turn = async (id: string, sequence: number, participants = ["Alice"]) => {
        await instance.signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: id,
          bodySequence: 1, turnSequence: sequence, participants, outcome: { kind: "answered", text: `answer ${sequence}` } });
        const notice = (await square.history({ from: [NOTIFIER], limit: null })).activities
          .find(activity => isTurnNotice(activity, id, sequence));
        assert.ok(notice);
        return notice;
      };
      const selected = await turn("aku/one", 1, ["Alice", "Bob"]);
      assert.deepEqual(queues().map(args => args[2]), ["other-recipient"], "another recipient wakes normally");
      assert.equal((await square.snapshot()).delivered("Alice", selected.id), false);
      await instance.signals?.["akuma.outcome-observed"]?.({ kind: "akuma.outcome-observed", akumaId: "aku/one", historyId: "turn/1" });
      assert.equal((await square.snapshot()).delivered("Alice", selected.id), true, "exact acknowledgment precedes release");
      const pending = await turn("aku/one", 2);
      await turn("aku/two", 1);
      assert.equal(queues().length, 1, "all selected Akumas are held");
      await turn("aku/unselected", 1);
      await instance.signals?.["akuma.born"]?.({ kind: "akuma.born", akumaId: "aku/one", bodySequence: 1,
        origin: { kind: "direct" }, caller: { kind: "unknown" }, initiator: "Alice" });
      const birth = (await square.history({ from: [NOTIFIER], limit: null })).activities
        .find(activity => activity.kind === "say" && activity.body?.includes("called aku/one"));
      assert.ok(birth, "the birth record is still expressed");
      assert.deepEqual(birth.mentions ?? [], [], "the birth record addresses no one");
      await instance.signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: "aku/one", bodySequence: 1,
        end: "broke-off", participants: ["Alice"] });
      assert.deepEqual(queues().slice(1).map(args => args[2]), ["requester", "requester"],
        "nonselected outcomes and Body endings bypass Turn deferral; an unaddressed birth wakes no one");
      await first.close();
      await first.close();
      await turn("aku/one", 3);
      assert.equal(queues().length, 3, "one close cannot release the overlapping scope");
      await turn("aku/two", 2);
      assert.equal(queues().length, 4, "the nonoverlapping lease was released");
      await second.close();
      await turn("aku/one", 4);
      assert.equal(queues().length, 5, "ordinary delivery resumes after the last scope closes");
      assert.equal((await square.snapshot()).delivered("Alice", pending.id), false,
        "deferral and release never acknowledge an unobserved outcome");
      t.diagnostic("accepted Square: real adapter acquire/suppress/exact ack/independent release verified");
    } finally { await peer.close(); await square.close(); }
  } finally {
    await Promise.all(scopes.map(scope => scope.close()));
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Square plugin attributes calls to their caller and expresses every Turn outcome", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-plugin-square-"));
  const ambient = ambientSessionIdentity();
  const prior = {
    ...ambient,
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
    OPENCODE_SESSION_ID: process.env.OPENCODE_SESSION_ID,
    PI_SESSION_ID: process.env.PI_SESSION_ID,
    PASEO_AGENT_ID: process.env.PASEO_AGENT_ID,
    SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT,
    SQUARE_CODEX_BOUNDARIES: process.env.SQUARE_CODEX_BOUNDARIES,
    SQUARE_CODEX_BIN: process.env.SQUARE_CODEX_BIN,
    SQUARE_CODEX_QUEUE_LOG: process.env.SQUARE_CODEX_QUEUE_LOG,
  };
  for (const name of Object.keys(ambient)) delete process.env[name];
  try {
    assert.deepEqual(squarePlugin.manifest, {
      id: "square",
      apiVersion: 1,
      writablePaths: [{ name: "square", path: ".square" }],
    });
    mkdirSync(join(root, ".square"), { recursive: true });
    process.env.CODEX_THREAD_ID = "caller";
    process.env.PASEO_AGENT_ID = "";
    process.env.SQUARE_PARTICIPANT_NAME = "Alice";
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "square-ledger");
    process.env.SQUARE_CODEX_BOUNDARIES = join(root, "codex-boundaries.json");
    const codexQueueLog = join(root, "codex-queue.log");
    if (process.platform !== "win32") {
      const fakeCodex = join(root, "fake-codex");
      writeFileSync(
        fakeCodex,
        [
          "#!/usr/bin/env node",
          "require('node:fs').appendFileSync(process.env.SQUARE_CODEX_QUEUE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
        ].join("\n"),
      );
      chmodSync(fakeCodex, 0o755);
      process.env.SQUARE_CODEX_BIN = fakeCodex;
      process.env.SQUARE_CODEX_QUEUE_LOG = codexQueueLog;
    }
    const instance = await activateSquare(root);
    const handler = instance.signals?.["akuma.turn-outcome"];
    assert.ok(handler);
    assert.ok(instance.signals?.["akuma.body-ended"]);
    await instance.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Alice" });
    process.env.CODEX_THREAD_ID = "child";
    process.env.SQUARE_PARTICIPANT_NAME = "Child";
    const child = await activateSquare(root);
    const born = child.signals?.["akuma.born"];
    assert.ok(born);
    await born({
      kind: "akuma.born", akumaId: "aku/called", bodySequence: 1,
      origin: { kind: "direct" }, caller: { kind: "akuma", world: root, akuId: "aku/caller" },
      initiator: "Alice", contractId: "kei/example",
    });
    await born({
      kind: "akuma.born", akumaId: "aku/silent", bodySequence: 1,
      origin: { kind: "direct" }, caller: { kind: "unknown" },
    });
    process.env.CODEX_THREAD_ID = "teller";
    process.env.SQUARE_PARTICIPANT_NAME = "Bob";
    const teller = await activateSquare(root);
    await teller.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Bob" });
    if (process.platform !== "win32") {
      writeFileSync(
        process.env.SQUARE_CODEX_BOUNDARIES,
        `${JSON.stringify({ v: 1, nextSequence: 1, threads: { caller: { lastStop: 1, lastNonStop: 0 }, teller: { lastStop: 1, lastNonStop: 0 } } })}\n`,
      );
    }
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
      bodySequence: 1,
      turnSequence: 1,
      initiator: "Alice",
      participants: ["Alice"],
      outcome: { kind: "answered", text: "done" },
      contractId: "kei/example",
    });
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
      bodySequence: 1,
      turnSequence: 2,
      initiator: "Bob",
      participants: ["Bob"],
      outcome: { kind: "answered", text: "adjusted" },
      contractId: "kei/example",
    });
    assert.equal(existsSync(squarePath(root)), true);
    const recorded = await expressions(squarePath(root));
    const birthRecord = recorded.find(expression => expression.body.startsWith("Alice called aku/called"));
    assert.deepEqual(birthRecord?.mentions, [], "the birth record stays visible and addresses no initiator");
    assert.deepEqual(recorded, [
      outcome("Alice called aku/called (caller: aku/caller)\nignore if you have already seen this."),
      turnOutcome("✓ aku/answered came back\nturn/1 · requested by @Alice · kei/example\n\n---\n\ndone", "aku/answered", 1, ["Alice"]),
      turnOutcome("✓ aku/answered came back\nturn/2 · requested by @Bob · kei/example\n\n---\n\nadjusted", "aku/answered", 2, ["Bob"]),
    ]);
    if (process.platform !== "win32") {
      const queued = readFileSync(codexQueueLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(queued.length, 2);
      assert.deepEqual(queued[0]?.slice(0, 3), ["queue", "--thread", "caller"]);
      assert.deepEqual(queued[1]?.slice(0, 3), ["queue", "--thread", "teller"]);
      assert.match(queued[0]?.at(-1) ?? "", /<square-activity [^>]*as="Alice" id="act\/\d+" from="keiyaku-notice">/u);
    }

    delete process.env.CODEX_THREAD_ID;
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.OPENCODE_SESSION_ID;
    delete process.env.PI_SESSION_ID;
    delete process.env.SQUARE_PARTICIPANT_NAME;
    const fallback = await activateSquare(root);
    const fallbackHandler = fallback.signals?.["akuma.turn-outcome"];
    assert.ok(fallbackHandler);
    assert.ok(fallback.signals?.["akuma.body-ended"]);
    const externalBorn = fallback.signals?.["akuma.born"];
    assert.ok(externalBorn);
    await externalBorn({ kind: "akuma.born", akumaId: "aku/external", bodySequence: 1,
      origin: { kind: "direct" }, caller: { kind: "external", integration: "test", id: "not-an-aku" } });
    await externalBorn({ kind: "akuma.born", akumaId: "aku/external", bodySequence: 1, initiator: "Bob",
      origin: { kind: "direct" }, caller: { kind: "external", integration: "test", id: "not-an-aku" } });
    await fallbackHandler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/failed",
      bodySequence: 1,
      turnSequence: 3,
      outcome: { kind: "failed", reason: "provider failed" },
    });
    assert.deepEqual(await expressions(squarePath(root)), [
      outcome("Alice called aku/called (caller: aku/caller)\nignore if you have already seen this."),
      turnOutcome("✓ aku/answered came back\nturn/1 · requested by @Alice · kei/example\n\n---\n\ndone", "aku/answered", 1, ["Alice"]),
      turnOutcome("✓ aku/answered came back\nturn/2 · requested by @Bob · kei/example\n\n---\n\nadjusted", "aku/answered", 2, ["Bob"]),
      outcome("Bob called aku/external\nignore if you have already seen this."),
      turnOutcome("× aku/failed came back\nturn/3 failed\n\n---\n\nprovider failed", "aku/failed", 3),
    ]);
    const square = await Square.at({ path: squarePath(root) });
    try {
      assert.deepEqual((await square.participants()).participants.map(({ name }) => name).sort(), [
        "Alice",
        "Bob",
        NOTIFIER,
      ]);
    } finally {
      await square.close();
    }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("one shared notifier sends after its worker is done and needs no worker participant", async () => {
  await withSquareNotificationFixture("notifier-shared", async (fixture) => {
    await fixture.square(async (square) => {
      await (await square.join("aku/gone", { owner: fixture.owner })).participant.done();
    });
    await fixture.answeredTurn("aku/gone", 1, 1, "Alice", "after shutdown");
    // No participant ever stood for this Akuma.
    await fixture.answeredTurn("aku/absent", 2, 1, "Bob", "no worker at all");
    assert.deepEqual(await fixture.expressions(), [
      turnOutcome("✓ aku/gone came back\nturn/1 · requested by @Alice\n\n---\n\nafter shutdown", "aku/gone", 1, ["Alice"]),
      turnOutcome("✓ aku/absent came back\nturn/1 · requested by @Bob\n\n---\n\nno worker at all", "aku/absent", 1, ["Bob"]),
    ]);
    const absentNotice = await outcomeNotice(fixture, "aku/absent", 1);
    // Observation needs the observer's standing, not a standing subject worker; it
    // acknowledges only where the notice is actually available to that observer.
    await fixture.observe("aku/absent", "turn/1", "Bob");
    await fixture.square(async (square) => {
      const roster = (await square.participants()).participants;
      assert.equal(roster.find(({ name }) => name === "aku/gone")?.presence, "done");
      assert.equal(roster.some(({ name }) => name === "aku/absent"), false);
      assert.equal((await square.snapshot()).delivered("Bob", absentNotice.id), true);
      assert.equal((await square.snapshot()).delivered("Alice", absentNotice.id), false);
    });
  });
});

test("the shared notifier reuses active custody and rejoins only after it is done", async () => {
  await withSquareNotificationFixture("notifier-custody", async (fixture) => {
    const joinCount = async (): Promise<number> => fixture.square(async (square) =>
      (await square.history({ from: [NOTIFIER], limit: null })).activities.filter(({ kind }) => kind === "join").length);
    await fixture.answeredTurn("aku/one", 1, 1, "Alice", "one");
    await fixture.answeredTurn("aku/two", 1, 1, "Bob", "two");
    assert.equal(await joinCount(), 1, "an active notifier is reused without another join");
    await fixture.square(async (square) => {
      await (await square.participant(NOTIFIER, { owner: notifierOwner })).done();
    });
    await fixture.answeredTurn("aku/three", 1, 1, "Alice", "three");
    assert.equal(await joinCount(), 2, "a done notifier receives an ordinary rejoin");
    assert.deepEqual((await fixture.expressions()).map(({ actor }) => actor), [NOTIFIER, NOTIFIER, NOTIFIER]);
  });
});

test("an ending harness session never retires the shared notifier", async () => {
  await withSquareNotificationFixture("notifier-session", async (fixture) => {
    await fixture.answeredTurn("aku/session", 1, 1, "Alice", "kept");
    await fixture.square(async (square) => {
      await (await square.participant("Alice", { owner: fixture.owner })).done();
      assert.equal((await square.seatsOf(fixture.owner)).some(({ name }) => name === NOTIFIER), false);
    });
    await fixture.answeredTurn("aku/session", 1, 2, "Bob", "still there");
    const joins = await fixture.square(async (square) =>
      (await square.history({ from: [NOTIFIER], limit: null })).activities.filter(({ kind }) => kind === "join").length);
    assert.equal(joins, 1);
    await fixture.square(async (square) => {
      assert.deepEqual((await square.seatsOf(notifierOwner)).map(({ name }) => name), [NOTIFIER]);
    });
  });
});

test("shared notifier ownership refuses a foreign owner without takeover", async () => {
  await withSquareNotificationFixture("notifier-foreign", async (fixture) => {
    const foreignOwner = harnessOwner({ channel: "test", session: "foreign-notifier" });
    await fixture.square(async (square) => { await square.join(NOTIFIER, { owner: foreignOwner }); });
    await assert.rejects(fixture.answeredTurn("aku/foreign", 1, 1, "Alice", "refused"), { code: "already_joined" });
    assert.deepEqual(await fixture.expressions(), []);
    await fixture.square(async (square) => {
      assert.deepEqual((await square.seatsOf(foreignOwner)).map(({ name }) => name), [NOTIFIER]);
      await (await square.participant(NOTIFIER, { owner: foreignOwner })).done();
    });
    await fixture.answeredTurn("aku/owned", 1, 1, "Alice", "owned");
    await fixture.square(async (square) => {
      assert.deepEqual((await square.seatsOf(notifierOwner)).map(({ name }) => name), [NOTIFIER]);
    });
  });
});

test("outcome observation catches exact notices only for the explicit observer", async () => {
  await withSquareNotificationFixture("ack", async (fixture) => {
    await fixture.answeredTurn("aku/worker", 1, 1, "Alice", "done", undefined, ["Alice", "Bob"]);
    await fixture.answeredTurn("aku/worker", 1, 10, "Alice", "later");
    await fixture.failedTurn("aku/worker", 1, 2, "Alice", "failed", undefined, ["Alice", "Bob"]);
    await fixture.bodyEnd("aku/worker", 2, "hung", "Alice");
    await fixture.square(async (square) => {
      const worker = (await square.join("aku/worker", { owner: fixture.owner })).participant;
      await worker.express("incidental aku/worker turn/1", { mentions: ["Alice", "Bob"], noMention: true, force: true });
      await worker.express("aku/worker turn/1 extra\ndone\nignore if you have already seen this.",
        { mentions: ["Alice", "Bob"], noMention: true, force: true });
      // Retained exact notices from the former per-Akuma author.
      await worker.express("aku/worker turn/1 (@Alice)\ndone\nignore if you have already seen this.",
        { mentions: ["Alice", "Bob"], noMention: true, force: true });
      await worker.express("aku/worker turn/2 (@Alice)\n× failed\nignore if you have already seen this.",
        { mentions: ["Alice", "Bob"], noMention: true, force: true });
      const other = (await square.join("aku/other", { owner: fixture.owner })).participant;
      await other.express("aku/worker turn/1\ndone\nignore if you have already seen this.",
        { mentions: ["Alice", "Bob"], noMention: true, force: true });
    });
    const { activities: notices } = await fixture.square((square) => square.history({ limit: null }));
    const noticeFor = (prefix: string, actor = NOTIFIER): Activity | undefined =>
      notices.find((item) => item.actor === actor && item.body?.startsWith(prefix));
    const first = noticeFor("✓ aku/worker came back\nturn/1 · requested by @Alice");
    const failed = noticeFor("× aku/worker came back\nturn/2 failed · requested by @Alice");
    // Retained notices from the former per-Akuma author stay observable.
    const legacyFirst = noticeFor("aku/worker turn/1 (@Alice)", "aku/worker");
    const legacyFailed = noticeFor("aku/worker turn/2 (@Alice)", "aku/worker");
    assert.ok(first);
    assert.ok(failed);
    assert.ok(legacyFirst);
    assert.ok(legacyFailed);
    // Explicit attribution wins even while the plugin's process belongs to someone else.
    await fixture.observe("aku/worker", "turn/1", "Bob");
    await fixture.observe("aku/worker", "turn/1", "Bob");
    await fixture.observe("aku/worker", "turn/2", "Bob");
    await fixture.observe("aku/worker", "body/2", "Bob");
    await fixture.square(async (square) => {
      const snapshot = await square.snapshot();
      const delivered = new Set([first.id, failed.id, legacyFirst.id, legacyFailed.id]);
      for (const notice of notices.filter((item) => item.kind === "say")) {
        assert.equal(snapshot.delivered("Alice", notice.id), false);
        assert.equal(snapshot.delivered("Bob", notice.id), delivered.has(notice.id));
      }
      const pending = await (await square.participant("Bob", { owner: fixture.owner })).catch();
      assert.ok(pending.activities.some((item) => item.body?.startsWith("incidental")));
      assert.ok(pending.activities.some((item) => item.actor === "aku/other"));
    });
  });
});

test("answer and failure notices preserve exact results and structured identity", async () => {
  await withSquareNotificationFixture("answer-forms", async (fixture) => {
    await fixture.answeredTurn(
      "aku/forms",
      1,
      1,
      "Alice",
      "first line\nsecond line",
      undefined,
      undefined,
      "kei/example",
    );
    await fixture.answeredTurn("aku/forms", 1, 2, undefined, "", undefined, ["Alice"]);
    await fixture.failedTurn("aku/forms", 1, 3, "Bob", "denied\nbecause", undefined, undefined, "kei/failure");
    assert.deepEqual(await fixture.expressions(), [
      turnOutcome(
        "✓ aku/forms came back\nturn/1 · requested by @Alice · kei/example\n\n---\n\nfirst line\nsecond line",
        "aku/forms",
        1,
        ["Alice"],
      ),
      turnOutcome("✓ aku/forms came back\nturn/2\n\n---\n\n", "aku/forms", 2, ["Alice"]),
      turnOutcome(
        "× aku/forms came back\nturn/3 failed · requested by @Bob · kei/failure\n\n---\n\ndenied\nbecause",
        "aku/forms",
        3,
        ["Bob"],
      ),
    ]);
    await fixture.observe("aku/forms", "turn/1", "Alice");
    await fixture.observe("aku/forms", "turn/2", "Alice");
    await fixture.observe("aku/forms", "turn/3", "Bob");
    const first = await outcomeNotice(fixture, "aku/forms", 1);
    const empty = await outcomeNotice(fixture, "aku/forms", 2);
    const failed = await outcomeNotice(fixture, "aku/forms", 3);
    await fixture.square(async (square) => {
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered("Alice", first.id), true);
      assert.equal(snapshot.delivered("Alice", empty.id), true);
      assert.equal(snapshot.delivered("Bob", failed.id), true);
      assert.deepEqual(first.metadata, {
        keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/forms", historyId: "turn/1" },
      });
    });
  });
});

test("current Turn acknowledgment trusts exact structured identity, never current prose or malformed metadata", async () => {
  await withSquareNotificationFixture("metadata-ack", async (fixture) => {
    const notices = await fixture.square(async (square) => {
      const notifier = (await square.join(NOTIFIER, { owner: notifierOwner })).participant;
      const current = await notifier.express({
        body: "prose has no outcome identity at all",
        metadata: { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/meta", historyId: "turn/1" } },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const currentStyleWithoutMetadata = await notifier.express({
        body: "✓ aku/meta came back\nturn/1\n\n---\n\nanswer",
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const legacyShaped = "aku/meta turn/1\ndone\nignore if you have already seen this.";
      const malformed = await notifier.express({
        body: legacyShaped,
        metadata: { keiyaku: "not an identity object" },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const wrongKind = await notifier.express({
        body: legacyShaped,
        metadata: { keiyaku: { kind: "akuma.born", akumaId: "aku/meta", historyId: "turn/1" } },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const wrongAkuma = await notifier.express({
        body: legacyShaped,
        metadata: { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/other", historyId: "turn/1" } },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const wrongTurn = await notifier.express({
        body: legacyShaped,
        metadata: { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/meta", historyId: "turn/2" } },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const extraIdentityField = await notifier.express({
        body: legacyShaped,
        metadata: { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/meta", historyId: "turn/1", extra: true } },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      const extraNamespace = await notifier.express({
        body: legacyShaped,
        metadata: {
          keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/meta", historyId: "turn/1" },
          other: "not the exact notice envelope",
        },
        mentions: ["Alice"],
        noMention: true,
        force: true,
      });
      return [
        current,
        currentStyleWithoutMetadata,
        malformed,
        wrongKind,
        wrongAkuma,
        wrongTurn,
        extraIdentityField,
        extraNamespace,
      ].map(({ activity }) => activity);
    });
    await fixture.observe("aku/meta", "turn/1", "Alice");
    await fixture.square(async (square) => {
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered("Alice", notices[0]!.id), true, "exact metadata matches despite arbitrary prose");
      for (const notice of notices.slice(1, -1)) {
        assert.equal(
          snapshot.delivered("Alice", notice.id),
          false,
          "prose cannot rescue missing, malformed, or mismatched metadata",
        );
      }
      assert.equal(
        snapshot.delivered("Alice", notices.at(-1)!.id),
        true,
        "an unrelated root namespace does not erase the exact keiyaku identity",
      );
    });
  });
});
test("outcome observation acknowledges every exact duplicate beyond the default history page without joining", async (t) => {
  await withSquareNotificationFixture("ack-full-archive", async (fixture) => {
    const notices = await fixture.square(async (square) => {
      const notifier = (await square.join(NOTIFIER, { owner: notifierOwner })).participant;
      const ids: Activity["id"][] = [];
      for (let index = 0; index < 12; index++) {
        const result = await notifier.express("aku/repeated turn/1\nack\nignore if you have already seen this.",
          { mentions: ["Alice", "Bob"], noMention: true, force: true });
        ids.push(result.activity.id);
      }
      return ids;
    });
    const forbidJoin = t.mock.method(squarePrototype, "join", async () => { throw new Error("observation must not join"); });
    const forbidReattach = t.mock.method(squarePrototype, "reattach", async () => { throw new Error("observation must not reenter"); });
    await fixture.observe("aku/repeated", "turn/1", "Bob");
    forbidJoin.mock.restore();
    forbidReattach.mock.restore();
    await fixture.square(async (square) => {
      const snapshot = await square.snapshot();
      for (const id of notices) {
        assert.equal(snapshot.delivered("Bob", id), true);
        assert.equal(snapshot.delivered("Alice", id), false);
      }
    });
  });
});

test("outcome observation catches an unmentioned listener's notice without consuming another listener", async () => {
  await withSquareNotificationFixture("listener-ack", async (fixture) => {
    await fixture.square(async (square) => {
      for (const name of ["Alice", "Bob"]) {
        // The shared notifier is the author, so listening to the subject worker
        // no longer addresses its notices.
        await (await square.join(name, { owner: fixture.owner })).participant.listen(NOTIFIER);
      }
    });
    await fixture.answeredTurn("aku/listened", 1, 1, undefined, "public to listeners");
    const notice = await outcomeNotice(fixture, "aku/listened", 1);
    assert.deepEqual(notice.mentions, []);
    await fixture.observe("aku/listened", "turn/1", "Bob");
    await fixture.square(async (square) => {
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered("Bob", notice.id), true);
      assert.equal(snapshot.delivered("Alice", notice.id), false);
    });
  });
});

test("observation does not create missing Square custody or anticipate a later notice", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instance = await activateSquare(root);
  const observed = instance.signals?.["akuma.outcome-observed"];
  assert.ok(observed);
  await observed({ kind: "akuma.outcome-observed", akumaId: "aku/missing", historyId: "turn/1", observer: "Ghost" });
  assert.equal(existsSync(join(root, ".square")), false);
  await withSquareNotificationFixture("absence", async (fixture) => {
    await fixture.observe("aku/late", "turn/1", "Alice");
    await fixture.answeredTurn("aku/late", 1, 1, "Alice", "late");
    await fixture.observe("aku/late", "turn/1", "Ghost");
    await fixture.observe("aku/late", "turn/1", "Bob"); // Not in its landed audience.
    await fixture.square(async (square) => {
      const notice = (await square.history({ from: [NOTIFIER], limit: null })).activities.find((item) => item.kind === "say")!;
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), false);
      const alice = (await square.join("Alice", { owner: fixture.owner })).participant;
      await alice.done();
    });
    await fixture.observe("aku/late", "turn/1", "Alice");
    await fixture.square(async (square) => {
      const notice = (await square.history({ from: [NOTIFIER], limit: null })).activities.find((item) => item.kind === "say")!;
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered("Alice", notice.id), false);
      assert.equal(snapshot.participants.find((item) => item.name === "Alice")?.presence, "done");
      assert.equal(snapshot.participants.some((item) => item.name === "Ghost"), false);
    });
  });
});

test("local observation uses captured identity and cancellation prevents acknowledgment", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-local-ack-"));
  const prior = { ...ambientSessionIdentity(), SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  try {
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "ledger");
    const noIdentity = await activateSquare(root);
    process.env.PI_SESSION_ID = "local-observer";
    const instance = await activateSquare(root);
    await instance.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Alice" });
    await instance.signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: "aku/local",
      bodySequence: 1, turnSequence: 1, participants: ["Alice"], outcome: { kind: "answered", text: "ok" } });
    const event = { kind: "akuma.outcome-observed" as const, akumaId: "aku/local", historyId: "turn/1" };
    await noIdentity.signals?.["akuma.outcome-observed"]?.(event);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(Promise.resolve(instance.signals?.["akuma.outcome-observed"]?.(event, controller.signal)));
    const square = await Square.at({ path: squarePath(root), env: {} });
    try {
      const notice = (await square.history({ from: [NOTIFIER], limit: null })).activities.find((item) => item.kind === "say")!;
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), false);
      const interrupted = new AbortController();
      const originalHistory = squarePrototype.history;
      const historyMock = t.mock.method(squarePrototype, "history", async function (this: Square,
        ...[query, control]: Parameters<typeof originalHistory>) {
        assert.equal(control?.signal, interrupted.signal);
        const result = await originalHistory.call(this, query, control);
        interrupted.abort();
        return result;
      });
      await assert.rejects(Promise.resolve(instance.signals?.["akuma.outcome-observed"]?.(event, interrupted.signal)));
      historyMock.mock.restore();
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), false);
      process.env.SQUARE_PARTICIPANT_NAME = "WrongLaterIdentity";
      await instance.signals?.["akuma.outcome-observed"]?.(event);
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), true);
      t.mock.method(Square, "at", async () => { throw new Error("broken Square read"); });
      await assert.rejects(Promise.resolve(instance.signals?.["akuma.outcome-observed"]?.(event)), /broken Square read/u);
    } finally { await square.close(); }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Square cancellation stops a contended open and never joins after the lock is released", async (t) => {
  await withSquareNotificationFixture("cancel-open", async (fixture) => {
    const controller = new AbortController();
    const { promise: opening, resolve: markOpening } = promiseBarrier<void>();
    await fixture.square(async (square) => {
      const locked = new DatabaseSync(square.location);
      locked.exec("BEGIN EXCLUSIVE");
      const originalAt = Square.at;
      const at = t.mock.method(Square, "at", (...arguments_: Parameters<typeof originalAt>) => {
        assert.equal(arguments_[1]?.signal, controller.signal);
        markOpening();
        return originalAt.call(Square, ...arguments_);
      });
      try {
        const attempt = fixture.answeredTurn("aku/cancel-open", 1, 1, "Alice", "cancelled", controller.signal);
        const rejected = assert.rejects(attempt, { name: "AbortError" });
        await opening;
        controller.abort();
        await rejected;
      } finally {
        at.mock.restore();
        locked.exec("ROLLBACK");
        locked.close();
      }
      assert.equal((await square.participants()).participants.some(({ name }) => name === NOTIFIER), false);
    });
  });
});

test("Square notifications refuse while held and cancelled expressions cannot land later", async () => {
  await withSquareNotificationFixture("bounded-express", async (fixture) => {
    await fixture.square(async (square) => { await (await square.participant("Alice", { owner: fixture.owner })).hold("paused"); });
    await assert.rejects(fixture.answeredTurn("aku/held", 1, 1, "Alice", "held"));
    await fixture.square(async (square) => { await (await square.participant("Alice", { owner: fixture.owner })).resume(); });
    assert.deepEqual(await fixture.expressions(), []);
    await fixture.withHeldExpression("aku/cancel-before-send", async ({ sent, release }) => {
      const controller = new AbortController();
      const attempt = fixture.failedTurn("aku/cancel-before-send", 1, 1, "Alice", "cancelled", controller.signal);
      const rejected = assert.rejects(attempt, { name: "AbortError" });
      await sent;
      controller.abort();
      release();
      await rejected;
    }, false);
    assert.deepEqual(await fixture.expressions(), []);
    await fixture.bodyEnd("aku/cancel-before-send", 1, "hung", "Alice");
    assert.equal((await fixture.bodies()).length, 1, "an unsent failure must not suppress its Body-end notice");
  });
});

test("the Square plugin reports abnormal Bodies without replacing Turn alerts", async () => {
  await withSquareNotificationFixture("body-end", async (fixture) => {
    await fixture.failedTurn("aku/same", 1, 1, "Alice", "failed first");
    await fixture.bodyEnd("aku/same", 1, "broke-off", "Alice", "provider stopped");
    await fixture.answeredTurn("aku/answered", 2, 2, "Alice", "done");
    await fixture.bodyEnd("aku/answered", 2, "hung", "Alice", "provider custody remained live");
    await fixture.failedTurn("aku/different", 3, 3, "Alice", "failed for Alice");
    await fixture.bodyEnd("aku/different", 3, "broke-off", "Bob", "different recipient");
    await fixture.bodyEnd("aku/silent", 4, "exited");
    await fixture.bodyEnd("aku/silent", 5, "put-down");
    assert.deepEqual(await fixture.expressions(), [
      turnOutcome("× aku/same came back\nturn/1 failed · requested by @Alice\n\n---\n\nfailed first", "aku/same", 1, ["Alice"]),
      turnOutcome("✓ aku/answered came back\nturn/2 · requested by @Alice\n\n---\n\ndone", "aku/answered", 2, ["Alice"]),
      outcome("aku/answered body/2 (@Alice)\n× interrupted: hung: provider custody remained live\nignore if you have already seen this.", ["Alice"]),
      turnOutcome("× aku/different came back\nturn/3 failed · requested by @Alice\n\n---\n\nfailed for Alice", "aku/different", 3, ["Alice"]),
      outcome("aku/different body/3 (@Bob)\n× interrupted: broke-off: different recipient\nignore if you have already seen this.", ["Bob"]),
    ]);
  });
});

test("Square canceled Turn notifies once, is exactly observed, and suppresses its Body interruption", async () => {
  await withSquareNotificationFixture("canceled-turn", async (fixture) => {
    await fixture.canceledTurn("aku/canceled", 1, 1, "Alice");
    await fixture.bodyEnd("aku/canceled", 1, "put-down", "Alice");
    assert.deepEqual(await fixture.expressions(), [
      turnOutcome("○ aku/canceled came back\nturn/1 canceled · requested by @Alice", "aku/canceled", 1, ["Alice"]),
    ]);
    await fixture.observe("aku/canceled", "turn/1", "Alice");
    const notice = await outcomeNotice(fixture, "aku/canceled", 1);
    await fixture.square(async (square) => {
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), true);
    });
  });
});

test("Square addresses all Turn participants and suppresses only already-notified Body recipients", async () => {
  await withSquareNotificationFixture("audience", async (fixture) => {
    await fixture.admit("Carol");
    await fixture.admit("Dana");
    await fixture.failedTurn("aku/group", 1, 1, "Alice", "failed", undefined, ["Alice", "Bob", "Carol"]);
    await fixture.bodyEnd("aku/group", 1, "broke-off", "Alice", "stopped", undefined, ["Alice", "Bob", "Carol", "Dana"]);
    await fixture.failedTurn("aku/silent-owner", 2, 2, undefined, "failed", undefined, ["Bob"]);
    await fixture.bodyEnd("aku/silent-owner", 2, "hung", undefined, undefined, undefined, ["Bob"]);
    await fixture.answeredTurn("aku/no-audience", 3, 3, "Alice", "done", undefined, []);
    assert.deepEqual(await fixture.expressions(), [
      turnOutcome("× aku/group came back\nturn/1 failed · requested by @Alice\n\n---\n\nfailed", "aku/group", 1, ["Alice", "Bob", "Carol"]),
      outcome("aku/group body/1 (@Alice)\n× interrupted: broke-off: stopped\nignore if you have already seen this.", ["Dana"]),
      turnOutcome("× aku/silent-owner came back\nturn/2 failed\n\n---\n\nfailed", "aku/silent-owner", 2, ["Bob"]),
      turnOutcome("✓ aku/no-audience came back\nturn/3 · requested by @Alice\n\n---\n\ndone", "aku/no-audience", 3),
    ]);
  });
});

test("same-Body notifications serialize while distinct Bodies overlap", async () => {
  await withSquareNotificationFixture("serialize", async (fixture) => {
    const failedExpression = turnOutcome("× aku/same came back\nturn/1 failed · requested by @Alice\n\n---\n\nfailed first", "aku/same", 1, ["Alice"]);
    await fixture.withHeldExpression("aku/same", async ({ sent, release }) => {
      const failed = fixture.failedTurn("aku/same", 1, 1, "Alice", "failed first");
      await sent;
      const interrupted = fixture.bodyEnd("aku/same", 1, "broke-off", "Alice", "provider stopped");
      assert.equal(await Promise.race([interrupted.then(() => true), Promise.resolve(false)]), false);
      assert.deepEqual(await fixture.expressions(), [failedExpression]);
      release();
      await Promise.all([failed, interrupted]);
      assert.deepEqual(await fixture.expressions(), [failedExpression]);
    });
  });
  await withSquareNotificationFixture("overlap", async (fixture) => {
    const liveExpression = turnOutcome("✓ aku/live-body came back\nturn/1 · requested by @Bob\n\n---\n\nlive", "aku/live-body", 1, ["Bob"]);
    const parkedExpression = turnOutcome("× aku/parked-body came back\nturn/1 failed · requested by @Alice\n\n---\n\nparked failure", "aku/parked-body", 1, ["Alice"]);
    await fixture.withHeldExpression("aku/parked-body", async ({ sent, release }) => {
      const parked = fixture.failedTurn("aku/parked-body", 1, 1, "Alice", "parked failure");
      await sent;
      await fixture.answeredTurn("aku/live-body", 1, 1, "Bob", "live");
      assert.deepEqual(await fixture.expressions(), [liveExpression]);
      release();
      await parked;
      assert.deepEqual(await fixture.expressions(), [liveExpression, parkedExpression]);
    }, false);
  });
});

test("Square notification authority survives rejection and cancellation boundaries", async () => {
  await withSquareNotificationFixture(
    "rejected",
    async (fixture) => {
      await assert.rejects(fixture.failedTurn("aku/rejected", 1, 1, "Ghost", "unknown recipient"));
      // Ghost becomes reachable only after the failed send already rejected; the same-recipient
      // Body notice must still be attempted rather than silently suppressed.
      await fixture.admit("Ghost");
      await fixture.bodyEnd("aku/rejected", 1, "broke-off", "Ghost", "route established late");
      assert.deepEqual(await fixture.expressions(), [
        outcome("aku/rejected body/1 (@Ghost)\n× interrupted: broke-off: route established late\nignore if you have already seen this.", ["Ghost"]),
      ]);
    },
    ["Alice"],
  );

  await withSquareNotificationFixture("authority", async (fixture) => {
    await fixture.withHeldExpression("aku/queued", async ({ sent, release }) => {
      const answered = fixture.answeredTurn("aku/queued", 1, 1, "Alice", "done");
      await sent;
      const controller = new AbortController();
      const queued = fixture.bodyEnd("aku/queued", 1, "hung", "Alice", undefined, controller.signal);
      controller.abort();
      release();
      await answered;
      await assert.rejects(queued);
      assert.equal((await fixture.bodies()).some((body) => body.startsWith("aku/queued body/1")), false);
    });
    await fixture.withHeldExpression("aku/late", async ({ sent, release }) => {
      const controller = new AbortController();
      const late = fixture.failedTurn("aku/late", 1, 1, "Alice", "late failure", controller.signal);
      await sent;
      controller.abort();
      release();
      await assert.rejects(late);
    });
    await fixture.bodyEnd("aku/late", 1, "broke-off", "Alice", "after timeout");
    assert.deepEqual(
      (await fixture.expressions()).filter(
        ({ body }) => body.startsWith("aku/late body/1 ") || body.startsWith("× aku/late came back\n"),
      ),
      [
        turnOutcome("× aku/late came back\nturn/1 failed · requested by @Alice\n\n---\n\nlate failure", "aku/late", 1, ["Alice"]),
        outcome("aku/late body/1 (@Alice)\n× interrupted: broke-off: after timeout\nignore if you have already seen this.", ["Alice"]),
      ],
    );
  });
});

test("Turn mentions follow the signal initiator, never the Body environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-initiator-"));
  const ambient = ambientSessionIdentity();
  const prior = {
    ...ambient,
    PI_SESSION_ID: process.env.PI_SESSION_ID,
    SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT,
  };
  for (const name of Object.keys(ambient)) delete process.env[name];
  try {
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "square-ledger");
    mkdirSync(join(root, ".square"), { recursive: true });
    for (const initiator of ["Alice", "Bob"]) {
      process.env.PI_SESSION_ID = `fixture-${initiator}`;
      process.env.SQUARE_PARTICIPANT_NAME = initiator;
      const submitter = await activateSquare(root);
      await submitter.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator });
    }
    process.env.SQUARE_PARTICIPANT_NAME = "OriginalCaller";
    const instance = await activateSquare(root);
    const handler = instance.signals?.["akuma.turn-outcome"];
    assert.ok(handler);
    for (const [index, initiator] of ["Alice", "Bob", undefined].entries()) {
      await handler({
        kind: "akuma.turn-outcome",
        akumaId: "aku/worker",
        bodySequence: 1,
        turnSequence: index + 1,
        ...(initiator === undefined ? {} : { initiator, participants: [initiator] }),
        outcome: { kind: "failed", reason: "fixture failure" },
      });
    }
    assert.deepEqual(
      await expressions(squarePath(root)),
      [
        turnOutcome("× aku/worker came back\nturn/1 failed · requested by @Alice\n\n---\n\nfixture failure", "aku/worker", 1, ["Alice"]),
        turnOutcome("× aku/worker came back\nturn/2 failed · requested by @Bob\n\n---\n\nfixture failure", "aku/worker", 2, ["Bob"]),
        turnOutcome("× aku/worker came back\nturn/3 failed\n\n---\n\nfixture failure", "aku/worker", 3),
      ],
    );
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi caller registration and outcomes share artifact ownership across execution directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-pi-inbox-"));
  const world = join(root, "world");
  const cwd = join(root, "execution");
  const priorCwd = process.cwd();
  const ambient = ambientSessionIdentity();
  const prior = {
    ...ambient,
    PWD: process.env.PWD,
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT,
  };
  for (const name of Object.keys(ambient)) delete process.env[name];
  try {
    mkdirSync(join(world, ".square"), { recursive: true });
    mkdirSync(cwd);
    process.chdir(cwd);
    delete process.env.PWD;
    process.env.PI_SESSION_ID = "fixture-pi-caller";
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "shared-ledger");
    const callerEnv = { ...process.env };
    const initiator = (await squareSeat({ path: world as WorldRoot, environment: callerEnv }))!;
    const submitter = await activateSquare(world);
    const initiating = submitter.signals?.["akuma.initiating"];
    assert.ok(initiating);
    await initiating({ kind: "akuma.initiating", initiator });

    const callerOwner = harnessOwner({ channel: "pi", session: callerEnv.PI_SESSION_ID! });
    const native = await Square.at({ path: squarePath(world), env: callerEnv });
    try {
      assert.equal(realpathSync(native.location), realpathSync(squarePath(world)));
      assert.deepEqual(
        (await native.seatsOf(callerOwner)).filter(({ attachment }) => attachment === "attached").map(({ name }) => name),
        [initiator],
      );
    } finally { await native.close(); }
    assert.equal(existsSync(join(cwd, ".square")), false);

    process.chdir(world);
    process.env.PI_SESSION_ID = "fixture-pi-body";
    const body = await activateSquare(world);
    await body.signals?.["akuma.turn-outcome"]?.({
      kind: "akuma.turn-outcome",
      akumaId: "aku/pi-inbox",
      bodySequence: 1,
      turnSequence: 1,
      initiator,
      participants: [initiator],
      outcome: { kind: "answered", text: "done" },
    });

    const square = await Square.at({ path: squarePath(world), env: callerEnv });
    try {
      const joined = await square.join(initiator, { owner: callerOwner });
      const caught = await joined.participant.catch();
      assert.ok(caught.activities.some((item) => item.body?.includes("\n\n---\n\ndone")));
    } finally {
      await square.close();
    }
    assert.equal(existsSync(squarePath(cwd)), false);
  } finally {
    process.chdir(priorCwd);
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("local observation acknowledges the recognized seat, never the former provider default", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-seat-observation-"));
  const prior = { ...ambientSessionIdentity(), SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  try {
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "host-ledger");
    mkdirSync(join(root, ".square"), { recursive: true });
    process.env.PI_SESSION_ID = "serving";
    const serving = { ...process.env };
    const submitter = await activateSquare(root);
    const seat = (await squareSeat({ path: root as WorldRoot, environment: serving }))!;
    assert.match(seat, /^keiyaku-assigned-[0-9a-f]{12}$/u);
    await submitter.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: seat });

    // The identity the former edge would have recomputed from this same session.
    const former = legacyPiName(serving.PI_SESSION_ID!);
    assert.match(former, /^pi-/u);
    process.env.PI_SESSION_ID = "elsewhere";
    const elsewhere = await Square.at({ path: squarePath(root), env: { ...process.env } });
    try {
      await elsewhere.join(former, { owner: harnessOwner({ channel: "pi", session: "elsewhere" }) });
    } finally {
      await elsewhere.close();
    }

    process.env.PI_SESSION_ID = "body";
    const body = await activateSquare(root);
    const turn = body.signals?.["akuma.turn-outcome"];
    assert.ok(turn);
    await turn({ kind: "akuma.turn-outcome", akumaId: "aku/seat", bodySequence: 1, turnSequence: 1,
      initiator: seat, participants: [seat], outcome: { kind: "answered", text: "ok" } });
    await turn({ kind: "akuma.turn-outcome", akumaId: "aku/seat", bodySequence: 1, turnSequence: 2,
      participants: [former], outcome: { kind: "answered", text: "ok" } });

    const square = await Square.at({ path: squarePath(root), env: {} });
    try {
      const standing = (await square.participants()).participants.map(({ name }) => name).sort();
      for (const historyId of ["turn/1", "turn/2"]) {
        await submitter.signals?.["akuma.outcome-observed"]?.({
          kind: "akuma.outcome-observed", akumaId: "aku/seat", historyId,
        });
      }
      const notices = (await square.history({ from: [NOTIFIER], limit: null })).activities
        .filter((activity) => activity.kind === "say");
      const seatNotice = notices.find((notice) => isTurnNotice(notice, "aku/seat", 1))!;
      const formerNotice = notices.find((notice) => isTurnNotice(notice, "aku/seat", 2))!;
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered(seat, seatNotice.id), true, "the recognized seat takes its own notice");
      assert.equal(
        snapshot.delivered(former, formerNotice.id),
        false,
        "a recomputed provider name never acknowledges another participant's notice",
      );
      const after = (await square.participants()).participants;
      assert.deepEqual(
        after.map(({ name }) => name).sort(),
        standing,
        "acknowledgment joins or creates no participant",
      );
      assert.deepEqual(after.find(({ name }) => name === seat)?.listening, [], "listen state is untouched");
    } finally {
      await square.close();
    }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit forwarded observer never borrows the serving session's identity or route", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-forwarded-observer-"));
  const prior = {
    ...ambientSessionIdentity(),
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT,
  };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  try {
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "host-ledger");
    mkdirSync(join(root, ".square"), { recursive: true });
    process.env.PI_SESSION_ID = "serving";
    const serving = { ...process.env };
    const submitter = await activateSquare(root);
    const seat = (await squareSeat({ path: root as WorldRoot, environment: serving }))!;
    await submitter.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: seat });

    process.env.PI_SESSION_ID = "requester";
    const requester = await activateSquare(root);
    await requester.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Forwarded" });

    process.env.PI_SESSION_ID = "body";
    const body = await activateSquare(root);
    const turn = body.signals?.["akuma.turn-outcome"];
    assert.ok(turn);
    await turn({ kind: "akuma.turn-outcome", akumaId: "aku/forwarded", bodySequence: 1, turnSequence: 1,
      initiator: "Forwarded", participants: ["Forwarded"], outcome: { kind: "answered", text: "ok" } });

    await submitter.signals?.["akuma.outcome-observed"]?.({
      kind: "akuma.outcome-observed", akumaId: "aku/forwarded", historyId: "turn/1", observer: "Forwarded",
    });

    const square = await Square.at({ path: squarePath(root), env: {} });
    try {
      const notice = (await square.history({ from: [NOTIFIER], limit: null })).activities
        .find((activity) => activity.kind === "say")!;
      assert.equal((await square.snapshot()).delivered("Forwarded", notice.id), false, "a forwarded name grants no authority");
      await requester.signals?.["akuma.outcome-observed"]?.({
        kind: "akuma.outcome-observed", akumaId: "aku/forwarded", historyId: "turn/1",
      });
      assert.equal((await square.snapshot()).delivered("Forwarded", notice.id), true, "the actual requester observes locally");
      assert.equal((await square.snapshot()).delivered(seat, notice.id), false, "the serving session is not the observer");
    } finally {
      await square.close();
    }
    const servingSquare = await Square.at({ path: squarePath(root), env: serving });
    try {
      const servingOwner = harnessOwner({ channel: "pi", session: serving.PI_SESSION_ID! });
      assert.deepEqual(
        (await servingSquare.seatsOf(servingOwner)).filter(({ attachment }) => attachment === "attached").map(({ name }) => name),
        [seat],
      );
    } finally { await servingSquare.close(); }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a declared name resolves an ambiguous session binding in local acknowledgment", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-explicit-ack-"));
  const prior = { ...ambientSessionIdentity(), SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  try {
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "host-ledger");
    mkdirSync(join(root, ".square"), { recursive: true });
    // One session that joined twice: Square can no longer name it on its own.
    process.env.PI_SESSION_ID = "ambiguous-session";
    const ambiguousOwner = harnessOwner({ channel: "pi", session: "ambiguous-session" });
    const joined = await Square.build({ path: squarePath(root), markdown: "", env: { ...process.env } });
    try {
      await (await joined.join("Stale", { owner: ambiguousOwner })).participant.catch();
      await (await joined.join("Declared", { owner: ambiguousOwner })).participant.catch();
    } finally {
      await joined.close();
    }

    process.env.PI_SESSION_ID = "body";
    const body = await activateSquare(root);
    const turn = body.signals?.["akuma.turn-outcome"];
    assert.ok(turn);
    await turn({ kind: "akuma.turn-outcome", akumaId: "aku/explicit", bodySequence: 1, turnSequence: 1,
      initiator: "Declared", participants: ["Declared"], outcome: { kind: "answered", text: "ok" } });
    await turn({ kind: "akuma.turn-outcome", akumaId: "aku/explicit", bodySequence: 1, turnSequence: 2,
      participants: ["Stale"], outcome: { kind: "answered", text: "ok" } });

    process.env.PI_SESSION_ID = "ambiguous-session";
    process.env.SQUARE_PARTICIPANT_NAME = "Declared";
    const local = await activateSquare(root);
    for (const historyId of ["turn/1", "turn/2"]) {
      await local.signals?.["akuma.outcome-observed"]?.({ kind: "akuma.outcome-observed", akumaId: "aku/explicit", historyId });
    }

    const square = await Square.at({ path: squarePath(root), env: {} });
    try {
      const notices = (await square.history({ from: [NOTIFIER], limit: null })).activities
        .filter((activity) => activity.kind === "say");
      const snapshot = await square.snapshot();
      const declaredNotice = notices.find((notice) => isTurnNotice(notice, "aku/explicit", 1))!;
      const staleNotice = notices.find((notice) => isTurnNotice(notice, "aku/explicit", 2))!;
      assert.equal(snapshot.delivered("Declared", declaredNotice.id), true, "the declared name resolves the binding");
      assert.equal(snapshot.delivered("Stale", staleNotice.id), false, "the other binding is left untouched");
    } finally {
      await square.close();
    }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});
