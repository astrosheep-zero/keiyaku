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
// A sender label only: notifications never acquire a participant seat.
const NOTIFIER = "keiyaku-notice";
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
  const originalSend = squarePrototype.send;
  const { promise: sent, resolve: markSent } = promiseBarrier<void>();
  const { promise: released, resolve: release } = promiseBarrier<void>();
  squarePrototype.send = async function (...arguments_: Parameters<typeof originalSend>) {
    const { body } = arguments_[0];
    if (!body.startsWith(`✓ ${akumaId} came back\n`) && !body.startsWith(`× ${akumaId} came back\n`))
      return originalSend.call(this, ...arguments_);
    if (!holdAfterSend) { markSent(); await released; }
    const result = await originalSend.call(this, ...arguments_);
    if (holdAfterSend) { markSent(); await released; }
    return result;
  };
  try {
    return await callback({ sent, release });
  } finally {
    release();
    squarePrototype.send = originalSend;
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
        await fixture.square(async (square) => { await square.join(initiator, { owner: fixtureOwner }); });
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
    if ((initiators ?? ["Alice", "Bob"]).length > 0) {
      const square = await Square.build({ path: squarePath(root), markdown: "", env: fixtureEnvironment });
      try {
        for (const initiator of initiators ?? ["Alice", "Bob"]) await square.join(initiator, { owner: fixtureOwner });
      } finally { await square.close(); }
    }
    return await callback(fixture);
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
}

test("receiver binding joins and reattaches silently, never revives retired or takes foreign seats", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-auto-join-"));
  const prior = { ...ambientSessionIdentity(), SQUARE_INDEX: process.env.SQUARE_INDEX };
  for (const name of Object.keys(ambientSessionIdentity())) delete process.env[name];
  try {
    process.env.PI_SESSION_ID = "auto-join";
    process.env.SQUARE_INDEX = join(root, "index");
    mkdirSync(join(root, ".square"), { recursive: true });
    const instance = await activateSquare(root);
    const initiate = async (initiator: string) => instance.signals!["akuma.initiating"]!({ kind: "akuma.initiating", initiator });
    await initiate("Alice");
    assert.deepEqual(await expressions(squarePath(root)), []);
    await initiate("Alice");
    const square = await Square.at({ path: squarePath(root), env: { ...process.env } });
    try {
      const owner = harnessOwner({ channel: "pi", session: "auto-join" });
      const seat = (await square.seatsOf(owner)).find(item => item.name === "Alice")!;
      await square.detach("Alice", { owner, generation: seat.generation });
      await initiate("Alice");
      assert.equal((await square.seatsOf(owner)).find(item => item.name === "Alice")?.attachment, "attached");
      await (await square.participant("Alice", { owner })).done();
      await initiate("Alice");
      assert.equal((await square.participants()).participants.find(item => item.name === "Alice")?.presence, "done");
      await square.join("Foreign", { owner: harnessOwner({ channel: "pi", session: "foreign" }) });
      await assert.rejects(initiate("Foreign"), { code: "already_joined" });
      await instance.signals?.["akuma.outcome-observed"]?.({ kind: "akuma.outcome-observed", akumaId: "aku/x", historyId: "turn/1" });
      assert.deepEqual(await expressions(squarePath(root)), []);
    } finally { await square.close(); }
    delete process.env.PI_SESSION_ID;
    const anonymous = await activateSquare(root);
    await anonymous.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Nobody" });
    assert.deepEqual(await expressions(squarePath(root)), []);
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("birth and missing audiences stay silent without creating Square or guessing recipients", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-no-audience-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instance = await activateSquare(root);
  await instance.signals?.["akuma.born"]?.({ kind: "akuma.born", akumaId: "aku/no-audience", bodySequence: 1,
    initiator: "Alice", origin: { kind: "direct" }, caller: { kind: "unknown" } });
  for (const participants of [undefined, []]) {
    await instance.signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: "aku/no-audience",
      bodySequence: 1, turnSequence: 1, initiator: "Alice", ...(participants === undefined ? {} : { participants }),
      outcome: { kind: "answered", text: "@Bob is not a recipient" } });
    await instance.signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: "aku/no-audience",
      bodySequence: 1, end: "hung", initiator: "Alice", ...(participants === undefined ? {} : { participants }) });
  }
  assert.equal(existsSync(join(root, ".square")), false);
});

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
      NOTIFIER, "▸ aku/report reported\nreport/7 · body/2 · turn/3\n\n---\n\nProgress\n@Bob\n\nexact text", ["Alice"],
      { keiyaku: { kind: "akuma.reported", akumaId: "aku/report", bodySequence: 2,
        turnSequence: 3, reportSequence: 7, at: signal.at } },
    )]);
    await fixture.observe("aku/report", "turn/3", "Alice");
    await fixture.square(async (square) => {
      const alice = await square.participant("Alice", { owner: fixture.owner });
      const bob = await square.participant("Bob", { owner: fixture.owner });
      assert.equal((await alice.pending()).activities[0]?.body?.includes("Progress\n@Bob\n\nexact text"), true);
      assert.deepEqual((await bob.pending()).activities, []);
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
    (await square.history({ limit: null })).activities.find((activity) =>
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
      assert.ok(first);
      scopes.push(first);
      const second = await instance.waitDeferral({ akumaIds: ["aku/one"] });
      assert.ok(second);
      scopes.push(second);
      const queues = (): string[][] => existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
      await instance.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Carol" });
      assert.deepEqual(queues(), [], "receiver registration sends no announcement");
      await instance.signals?.["akuma.reported"]?.({ kind: "akuma.reported", akumaId: "aku/one",
        bodySequence: 1, turnSequence: 1, reportSequence: 1, text: "progress", at: "2026-10-30T00:00:00Z",
        initiator: "Alice" });
      assert.deepEqual(queues().map(args => args[2]), ["requester"], "a report wakes through an active Turn deferral");
      writeFileSync(log, "");
      const turn = async (id: string, sequence: number, participants = ["Alice"]) => {
        await instance.signals?.["akuma.turn-outcome"]?.({ kind: "akuma.turn-outcome", akumaId: id,
          bodySequence: 1, turnSequence: sequence, participants, outcome: { kind: "answered", text: `answer ${sequence}` } });
        const notice = (await square.history({ limit: null })).activities
          .find(activity => isTurnNotice(activity, id, sequence));
        assert.ok(notice);
        return notice;
      };
      const selected = await turn("aku/one", 1, ["Alice", "Bob"]);
      assert.deepEqual(queues().map(args => args[2]), ["other-recipient"], "another recipient wakes normally");
      assert.ok((await alice.pending()).activities.some(({ id }) => id === selected.id));
      await instance.signals?.["akuma.outcome-observed"]?.({ kind: "akuma.outcome-observed", akumaId: "aku/one", historyId: "turn/1" });
      assert.equal((await alice.pending()).activities.some(({ id }) => id === selected.id), false, "exact acknowledgment precedes release");
      const pending = await turn("aku/one", 2);
      await turn("aku/two", 1);
      assert.equal(queues().length, 1, "all selected Akumas are held");
      await turn("aku/unselected", 1);
      await instance.signals?.["akuma.born"]?.({ kind: "akuma.born", akumaId: "aku/one", bodySequence: 1,
        origin: { kind: "direct" }, caller: { kind: "unknown" }, initiator: "Alice" });
      const birth = (await square.history({ limit: null })).activities
        .find(activity => activity.kind === "say" && activity.body?.includes("called aku/one"));
      assert.equal(birth, undefined, "birth has no direct-message audience");
      await instance.signals?.["akuma.body-ended"]?.({ kind: "akuma.body-ended", akumaId: "aku/one", bodySequence: 1,
        end: "broke-off", participants: ["Alice"] });
      assert.deepEqual(queues().slice(1).map(args => args[2]), ["requester", "requester"],
        "nonselected outcomes and Body endings bypass Turn deferral; birth wakes no one");
      await first.close();
      await first.close();
      await turn("aku/one", 3);
      assert.equal(queues().length, 3, "one close cannot release the overlapping scope");
      await turn("aku/two", 2);
      assert.equal(queues().length, 4, "the nonoverlapping lease was released");
      await second.close();
      await turn("aku/one", 4);
      assert.equal(queues().length, 5, "ordinary delivery resumes after the last scope closes");
      assert.ok((await alice.pending()).activities.some(({ id }) => id === pending.id),
        "deferral and release never acknowledge an unobserved outcome");
      t.diagnostic("accepted Square: real adapter acquire/suppress/exact ack/independent release verified");
    } finally { await peer.close(); await square.close(); }
  } finally {
    await Promise.all(scopes.map(scope => scope.close()));
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistent direct outcomes wake only their explicit recipients across producer sessions", async () => {
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
      writeFileSync(process.env.SQUARE_CODEX_BOUNDARIES,
        JSON.stringify({ v: 1, nextSequence: 1, threads: { caller: { lastStop: 1, lastNonStop: 0 }, teller: { lastStop: 1, lastNonStop: 0 } } }));
    }
    const instance = await activateSquare(root);
    const handler = instance.signals?.["akuma.turn-outcome"];
    assert.ok(handler);
    assert.ok(instance.signals?.["akuma.body-ended"]);
    await instance.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator: "Alice" });
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
    const fullAnswer = "exact answer beyond the default delivery preview\n".repeat(100);
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
      bodySequence: 1,
      turnSequence: 1,
      initiator: "Alice",
      participants: ["Alice"],
      outcome: { kind: "answered", text: fullAnswer },
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
    assert.deepEqual(recorded, [
      turnOutcome(`✓ aku/answered came back\nturn/1 · requested by @Alice · kei/example\n\n---\n\n${fullAnswer}`, "aku/answered", 1, ["Alice"]),
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
      assert.ok(queued[0]?.at(-1)?.includes(fullAnswer), "wake delivery preserves the complete answer, not a preview");
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

    await fallbackHandler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/failed",
      bodySequence: 1,
      turnSequence: 3,
      outcome: { kind: "failed", reason: "provider failed" },
    });
    assert.deepEqual(await expressions(squarePath(root)), recorded, "no audience never falls back to the producer or initiator");
    const square = await Square.at({ path: squarePath(root) });
    try {
      assert.deepEqual((await square.participants()).participants.map(({ name }) => name).sort(), [
        "Alice",
        "Bob",
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
      assert.deepEqual((await (await square.participant("Bob", { owner: fixture.owner })).pending()).activities, []);
      const alicePending = await (await square.participant("Alice", { owner: fixture.owner })).pending();
      assert.equal(alicePending.activities.some(({ id }) => id === absentNotice.id), false, "only Bob was addressed");
      assert.equal(alicePending.activities.length, 1, "Alice's own outcome is still pending");
    });
  });
});

test("direct notices need no sender seat and do not wake sender listeners or body mentions", async () => {
  await withSquareNotificationFixture("direct-audience", async (fixture) => {
    await fixture.square(async (square) => {
      await (await square.participant("Bob", { owner: fixture.owner })).listen(NOTIFIER);
    });
    await fixture.answeredTurn("aku/direct", 1, 1, "Alice", "@Bob is content, not an audience");
    await fixture.square(async (square) => {
      assert.deepEqual((await square.participants()).participants.map(({ name }) => name).sort(), ["Alice", "Bob"]);
      const bob = await square.participant("Bob", { owner: fixture.owner });
      assert.deepEqual((await bob.pending()).activities, []);
      const alice = await square.participant("Alice", { owner: fixture.owner });
      assert.equal((await alice.pending()).activities[0]?.body?.endsWith("@Bob is content, not an audience"), true);
    });
  });
});

test("direct outcomes retain detached audiences without reattaching or acknowledging them", async () => {
  await withSquareNotificationFixture("detached-audience", async (fixture) => {
    await fixture.square(async (square) => {
      const alice = await square.participant("Alice", { owner: fixture.owner });
      await square.detach("Alice", { owner: fixture.owner, generation: alice.generation });
    });
    await fixture.answeredTurn("aku/detached", 1, 1, "Alice", "retained", undefined, ["Alice", "Bob"]);
    await fixture.observe("aku/detached", "turn/1", "Alice");
    await fixture.square(async (square) => {
      assert.equal((await square.seatsOf(fixture.owner)).find(({ name }) => name === "Alice")?.attachment, "detached");
      const alice = await square.reattach("Alice", { owner: fixture.owner });
      assert.ok(alice);
      assert.equal((await alice.pending()).activities.filter((notice) => isTurnNotice(notice, "aku/detached", 1)).length, 1);
      const bob = await square.participant("Bob", { owner: fixture.owner });
      assert.equal((await bob.pending()).activities.filter((notice) => isTurnNotice(notice, "aku/detached", 1)).length, 1);
    });
    await fixture.observe("aku/detached", "turn/1", "Alice");
    await fixture.square(async (square) => {
      assert.deepEqual((await (await square.participant("Alice", { owner: fixture.owner })).pending()).activities, []);
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
      await square.send({ from: "Other", to: ["Alice", "Bob"], body: "incidental aku/worker turn/1" });
    });
    const { activities: notices } = await fixture.square((square) => square.history({ limit: null }));
    const noticeFor = (prefix: string, actor = NOTIFIER): Activity | undefined =>
      notices.find((item) => item.actor === actor && item.body?.startsWith(prefix));
    const first = noticeFor("✓ aku/worker came back\nturn/1 · requested by @Alice");
    const failed = noticeFor("× aku/worker came back\nturn/2 failed · requested by @Alice");
    assert.ok(first);
    assert.ok(failed);
    // Explicit attribution wins even while the plugin's process belongs to someone else.
    await fixture.observe("aku/worker", "turn/1", "Bob");
    await fixture.observe("aku/worker", "turn/1", "Bob");
    await fixture.observe("aku/worker", "turn/2", "Bob");
    await fixture.observe("aku/worker", "body/2", "Bob");
    await fixture.square(async (square) => {
      const alicePending = await (await square.participant("Alice", { owner: fixture.owner })).pending();
      const bob = await square.participant("Bob", { owner: fixture.owner });
      const bobPending = await bob.pending();
      assert.ok(alicePending.activities.some(({ id }) => id === first.id));
      assert.ok(alicePending.activities.some(({ id }) => id === failed.id));
      assert.equal(bobPending.activities.some(({ id }) => id === first.id || id === failed.id), false);
      assert.ok(alicePending.activities.some((activity) => isTurnNotice(activity, "aku/worker", 10)));
      const pending = await bob.catch();
      assert.ok(pending.activities.some((item) => item.body?.startsWith("incidental")));
      assert.ok(pending.activities.some((item) => item.actor === "Other"));
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
    await fixture.square(async (square) => {
      assert.deepEqual((await (await square.participant("Alice", { owner: fixture.owner })).pending()).activities, []);
      assert.deepEqual((await (await square.participant("Bob", { owner: fixture.owner })).pending()).activities, []);
      assert.deepEqual(first.metadata, {
        keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/forms", historyId: "turn/1" },
      });
    });
  });
});

test("outcome acknowledgment uses structured identity independent of body or unrelated metadata", async () => {
  await withSquareNotificationFixture("metadata-ack", async (fixture) => {
    const notices = await fixture.square(async (square) => {
      const ids: Activity["id"][] = [];
      for (const metadata of [
        { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/meta", historyId: "turn/1", extra: true }, other: "namespace" },
        { keiyaku: { kind: "akuma.reported", akumaId: "aku/meta", historyId: "turn/1" } },
        { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/other", historyId: "turn/1" } },
        { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/meta", historyId: "turn/2" } },
      ]) {
        ids.push((await square.send({ from: NOTIFIER, to: "Alice", body: "arbitrary prose", metadata })).id);
      }
      return ids;
    });
    await fixture.observe("aku/meta", "turn/1", "Alice");
    await fixture.square(async (square) => {
      const pending = await (await square.participant("Alice", { owner: fixture.owner })).pending();
      assert.deepEqual(pending.activities.map(({ id }) => id), notices.slice(1));
    });
  });
});
test("outcome observation drains every matching pending page without archive scans or joining", async (t) => {
  await withSquareNotificationFixture("ack-full-archive", async (fixture) => {
    const notices = await fixture.square(async (square) => {
      const ids: Activity["id"][] = [];
      for (let index = 0; index < 105; index++) {
        const result = await square.send({ from: NOTIFIER, to: ["Alice", "Bob"], body: "duplicate",
          metadata: { keiyaku: { kind: "akuma.turn-outcome", akumaId: "aku/repeated", historyId: "turn/1" } } });
        ids.push(result.id);
      }
      return ids;
    });
    const pages: number[] = [];
    const originalParticipant = squarePrototype.participant;
    const receiverMock = t.mock.method(squarePrototype, "participant", async function (this: Square,
      ...arguments_: Parameters<typeof originalParticipant>) {
      const seat = await originalParticipant.call(this, ...arguments_);
      const pending = seat.pending.bind(seat), ack = seat.ack.bind(seat);
      let pageIds: readonly Activity["id"][] = [];
      t.mock.method(seat, "pending", async (...arguments_: Parameters<typeof pending>) => {
        const page = await pending(...arguments_);
        pageIds = page.activities.map(({ id }) => id);
        pages.push(pageIds.length);
        assert.deepEqual((await pending(...arguments_)).activities.map(({ id }) => id), pageIds,
          "querying the receiver does not consume a page");
        return page;
      });
      t.mock.method(seat, "ack", async (...arguments_: Parameters<typeof ack>) => {
        assert.deepEqual(arguments_[0], pageIds, "acknowledgment uses exactly the received IDs");
        return ack(...arguments_);
      });
      return seat;
    });
    const forbidJoin = t.mock.method(squarePrototype, "join", async () => { throw new Error("observation must not join"); });
    const forbidReattach = t.mock.method(squarePrototype, "reattach", async () => { throw new Error("observation must not reenter"); });
    const forbidHistory = t.mock.method(squarePrototype, "history", async () => { throw new Error("observation must not scan history"); });
    await fixture.observe("aku/repeated", "turn/1", "Bob");
    forbidJoin.mock.restore();
    forbidReattach.mock.restore();
    forbidHistory.mock.restore();
    receiverMock.mock.restore();
    assert.deepEqual(pages, [100, 5, 0], "acknowledged pages are requeried until empty, never truncated to one page");
    await fixture.square(async (square) => {
      assert.deepEqual((await (await square.participant("Bob", { owner: fixture.owner })).pending()).activities, []);
      const alicePending = await (await square.participant("Alice", { owner: fixture.owner })).pending();
      assert.deepEqual(alicePending.activities.map(({ id }) => id), notices.slice(0, 100));
      assert.equal(alicePending.remaining, 5);
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
      const alice = await square.participant("Alice", { owner: fixture.owner });
      assert.equal((await alice.pending()).activities.filter((item) => isTurnNotice(item, "aku/late", 1)).length, 1);
      await alice.done();
    });
    await fixture.observe("aku/late", "turn/1", "Alice");
    await fixture.square(async (square) => {
      const { participants } = await square.participants();
      assert.equal(participants.find((item) => item.name === "Alice")?.presence, "done");
      assert.equal(participants.some((item) => item.name === "Ghost"), false);
      const alice = (await square.join("Alice", { owner: fixture.owner })).participant;
      assert.equal((await alice.pending()).activities.filter((item) => isTurnNotice(item, "aku/late", 1)).length, 1,
        "retired observation consumed nothing");
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
      const alice = await square.participant("Alice", { owner: harnessOwner({ channel: "pi", session: "local-observer" }) });
      assert.equal((await alice.pending()).activities.filter((item) => isTurnNotice(item, "aku/local", 1)).length, 1);
      const interrupted = new AbortController();
      const originalParticipant = squarePrototype.participant;
      const participantMock = t.mock.method(squarePrototype, "participant", async function (this: Square,
        ...arguments_: Parameters<typeof originalParticipant>) {
        const seat = await originalParticipant.call(this, ...arguments_);
        const pending = seat.pending.bind(seat);
        t.mock.method(seat, "pending", async (...[query, control]: Parameters<typeof pending>) => {
          assert.equal(control?.signal, interrupted.signal);
          const result = await pending(query, control);
          interrupted.abort();
          return result;
        });
        return seat;
      });
      await assert.rejects(Promise.resolve(instance.signals?.["akuma.outcome-observed"]?.(event, interrupted.signal)));
      participantMock.mock.restore();
      assert.equal((await alice.pending()).activities.filter((item) => isTurnNotice(item, "aku/local", 1)).length, 1);
      process.env.SQUARE_PARTICIPANT_NAME = "WrongLaterIdentity";
      await instance.signals?.["akuma.outcome-observed"]?.(event);
      assert.deepEqual((await alice.pending()).activities, []);
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

test("cancelled direct sends cannot land later or suppress Body endings", async () => {
  await withSquareNotificationFixture("bounded-send", async (fixture) => {
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
    await fixture.square(async (square) => {
      assert.deepEqual((await (await square.participant("Alice", { owner: fixture.owner })).pending()).activities, []);
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
      const servingOwner = harnessOwner({ channel: "pi", session: "serving" });
      assert.deepEqual((await (await square.participant(seat, { owner: servingOwner })).pending()).activities, [],
        "the recognized seat takes its own notice");
      const foreign = await square.participant(former, { owner: harnessOwner({ channel: "pi", session: "elsewhere" }) });
      assert.equal((await foreign.pending()).activities.filter((notice) => isTurnNotice(notice, "aku/seat", 2)).length, 1,
        "a recomputed provider name never acknowledges another participant's notice");
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
      const forwarded = await square.participant("Forwarded", { owner: harnessOwner({ channel: "pi", session: "requester" }) });
      assert.equal((await forwarded.pending()).activities.length, 1, "a forwarded name grants no authority");
      await requester.signals?.["akuma.outcome-observed"]?.({
        kind: "akuma.outcome-observed", akumaId: "aku/forwarded", historyId: "turn/1",
      });
      assert.deepEqual((await forwarded.pending()).activities, [], "the actual requester observes locally");
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
      const declared = await square.participant("Declared", { owner: ambiguousOwner });
      const stale = await square.participant("Stale", { owner: ambiguousOwner });
      assert.deepEqual((await declared.pending()).activities, [], "the declared name resolves the binding");
      assert.equal((await stale.pending()).activities.filter((notice) => isTurnNotice(notice, "aku/explicit", 2)).length, 1,
        "the other binding is left untouched");
    } finally {
      await square.close();
    }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});
