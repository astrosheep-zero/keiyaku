import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHostLedgerPort, Square, squareAssignedParticipantName, type Activity } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import { squareSeat } from "../src/cli/square-identity.js";
import type { PluginHooks } from "../src/plugin/public.js";
import type { WorldRoot } from "../src/world.js";
import { deferred as promiseBarrier, restoreEnvironmentValues } from "./support/process.js";

const squarePath = (root: string): string => join(root, ".square", "KEIYAKU.square");

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
        ? [{ actor: activity.actor, body: activity.body, mentions: activity.mentions ?? [] }]
        : [],
    );
  } finally {
    await square.close();
  }
}

type BodyEndDetails = Omit<Parameters<NonNullable<PluginHooks["akuma.body-ended"]>>[0], "kind">;
type CapturedExpression = Readonly<{ actor: string; body: string; mentions: readonly string[] }>;
type HeldExpression = Readonly<{ sent: Promise<void>; release: () => void }>;

const captured = (actor: string, body: string, mentions: readonly string[] = []): CapturedExpression => ({ actor, body, mentions });
const optionalInitiator = (initiator: string | undefined): { initiator?: string } => (initiator === undefined ? {} : { initiator });
const optionalDiagnostic = (diagnostic: string | undefined): { diagnostic?: string } => (diagnostic === undefined ? {} : { diagnostic });
async function withHeldSquareExpression<T>(
  akumaId: string,
  callback: (barrier: HeldExpression) => Promise<T>,
  holdAfterSend = true,
): Promise<T> {
  const originalImplicitJoin = Square.prototype.implicitJoin;
  const { promise: sent, resolve: markSent } = promiseBarrier<void>();
  const { promise: released, resolve: release } = promiseBarrier<void>();
  Square.prototype.implicitJoin = async function (...arguments_: Parameters<typeof originalImplicitJoin>) {
    const [name] = arguments_;
    const joined = await originalImplicitJoin.call(this, ...arguments_);
    if (name !== akumaId || joined.participant === undefined) return joined;
    const express = joined.participant.express.bind(joined.participant);
    return {
      ...joined,
      participant: {
        ...joined.participant,
        express: async (...arguments_: Parameters<typeof express>) => {
          if (!holdAfterSend) {
            markSent();
            await released;
          }
          const result = await express(...arguments_);
          if (holdAfterSend) {
            markSent();
            await released;
          }
          return result;
        },
      },
    };
  };
  try {
    return await callback({ sent, release });
  } finally {
    release();
    Square.prototype.implicitJoin = originalImplicitJoin;
  }
}
type SquareNotificationFixture = Readonly<{
  admit(initiator: string): Promise<void>;
  failedTurn(
    akumaId: string,
    bodySequence: number,
    turnSequence: number,
    initiator: string | undefined,
    reason: string,
    cancellation?: AbortSignal,
    participants?: readonly string[],
  ): Promise<void>;
  answeredTurn(
    akumaId: string,
    bodySequence: number,
    turnSequence: number,
    initiator: string | undefined,
    text: string,
    cancellation?: AbortSignal,
    participants?: readonly string[],
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
  const prior = {
    SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT,
  };
  try {
    mkdirSync(join(root, ".square"), { recursive: true });
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "square-ledger");
    const instance = await activateSquare(root);
    const turn = instance.signals?.["akuma.turn-outcome"];
    const bodyEnd = instance.signals?.["akuma.body-ended"];
    const initiating = instance.signals?.["akuma.initiating"];
    const observed = instance.signals?.["akuma.outcome-observed"];
    assert.ok(observed);
    assert.ok(turn);
    assert.ok(bodyEnd);
    assert.ok(initiating);
    const fixture: SquareNotificationFixture = {
      async admit(initiator) {
        await initiating({ kind: "akuma.initiating", initiator });
      },
      async failedTurn(akumaId, bodySequence, turnSequence, initiator, reason, cancellation, participants) {
        await turn(
          {
            kind: "akuma.turn-outcome",
            akumaId,
            bodySequence,
            turnSequence,
            ...optionalInitiator(initiator),
            ...(participants === undefined && initiator === undefined ? {} : { participants: participants ?? [initiator!] }),
            outcome: { kind: "failed", reason },
          },
          cancellation,
        );
      },
      async answeredTurn(akumaId, bodySequence, turnSequence, initiator, text, cancellation, participants) {
        await turn(
          {
            kind: "akuma.turn-outcome",
            akumaId,
            bodySequence,
            turnSequence,
            ...optionalInitiator(initiator),
            ...(participants === undefined && initiator === undefined ? {} : { participants: participants ?? [initiator!] }),
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
        await observed({ kind: "akuma.outcome-observed", akumaId, historyId,
          ...(observer === undefined ? {} : { observer }) }, cancellation);
      },
      async square(operation) {
        const square = await Square.at({ path: squarePath(root), env: {} });
        try { return await operation(square); } finally { await square.close(); }
      },
      expressions: () => expressions(squarePath(root)),
      async bodies() {
        return (await expressions(squarePath(root))).map(({ body }) => body);
      },
      withHeldExpression: withHeldSquareExpression,
    };
    for (const initiator of initiators ?? ["Alice", "Bob"]) await fixture.admit(initiator);
    return await callback(fixture);
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
}

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
    process.env.PI_SESSION_ID = "fixture-pi-session";
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
    assert.deepEqual(await expressions(squarePath(root)), [
      { actor: "Alice", body: "aku/caller called aku/called\nignore if you have already seen this.", mentions: [] },
      {
        actor: "aku/answered",
        body: "aku/answered turn/1 (@Alice) kei/example\ndone\nignore if you have already seen this.",
        mentions: ["Alice"],
      },
      {
        actor: "aku/answered",
        body: "aku/answered turn/2 (@Bob) kei/example\nadjusted\nignore if you have already seen this.",
        mentions: ["Bob"],
      },
    ]);
    if (process.platform !== "win32") {
      const queued = readFileSync(codexQueueLog, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(queued.length, 2);
      assert.deepEqual(queued[0]?.slice(0, 3), ["queue", "--thread", "caller"]);
      assert.deepEqual(queued[1]?.slice(0, 3), ["queue", "--thread", "teller"]);
      assert.match(queued[0]?.at(-1) ?? "", /<square-activity [^>]*as="Alice" id="act\/\d+" from="aku\/answered">/u);
      const evidence = await createHostLedgerPort({ rootPath: join(root, "square-ledger") }).listWakeAttempts();
      assert.equal(
        evidence.filter((row) => row.kind === "wake" && row.outcome === "accepted" && ["Alice", "Bob"].includes(row.participant))
          .length,
        2,
      );
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
      { actor: "Alice", body: "aku/caller called aku/called\nignore if you have already seen this.", mentions: [] },
      {
        actor: "aku/answered",
        body: "aku/answered turn/1 (@Alice) kei/example\ndone\nignore if you have already seen this.",
        mentions: ["Alice"],
      },
      {
        actor: "aku/answered",
        body: "aku/answered turn/2 (@Bob) kei/example\nadjusted\nignore if you have already seen this.",
        mentions: ["Bob"],
      },
      { actor: "Bob", body: "called aku/external\nignore if you have already seen this.", mentions: [] },
      {
        actor: "aku/failed",
        body: "aku/failed turn/3\n× provider failed\nignore if you have already seen this.",
        mentions: [],
      },
    ]);
    const square = await Square.at({ path: squarePath(root) });
    try {
      assert.deepEqual((await square.participants()).participants.map(({ name }) => name).sort(), [
        "Alice",
        "Bob",
        "aku/answered",
        "aku/failed",
      ]);
    } finally {
      await square.close();
    }
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("outcome observation catches exact notices only for the explicit observer", async () => {
  await withSquareNotificationFixture("ack", async (fixture) => {
    await fixture.answeredTurn("aku/worker", 1, 1, "Alice", "done", undefined, ["Alice", "Bob"]);
    await fixture.answeredTurn("aku/worker", 1, 10, "Alice", "later");
    await fixture.failedTurn("aku/worker", 1, 2, "Alice", "failed", undefined, ["Alice", "Bob"]);
    await fixture.bodyEnd("aku/worker", 2, "hung", "Alice");
    await fixture.square(async (square) => {
      const worker = (await square.implicitJoin("aku/worker")).participant!;
      await worker.express("incidental aku/worker turn/1", { mentions: ["Alice", "Bob"], noMention: true, force: true });
      await worker.express("aku/worker turn/1 extra\ndone\nignore if you have already seen this.",
        { mentions: ["Alice", "Bob"], noMention: true, force: true });
      const other = (await square.implicitJoin("aku/other")).participant!;
      await other.express("aku/worker turn/1\ndone\nignore if you have already seen this.",
        { mentions: ["Alice", "Bob"], noMention: true, force: true });
    });
    const { activities: notices } = await fixture.square((square) => square.history({ fixed: "aku/worker", limit: null }));
    const first = notices.find((item) => item.body?.startsWith("aku/worker turn/1 (@Alice)"))!;
    const failed = notices.find((item) => item.body?.startsWith("aku/worker turn/2 (@Alice)"))!;
    assert.ok(first);
    assert.ok(failed);
    // Explicit attribution wins even while the plugin's process belongs to someone else.
    await fixture.observe("aku/worker", "turn/1", "Bob");
    await fixture.observe("aku/worker", "turn/1", "Bob");
    await fixture.observe("aku/worker", "turn/2", "Bob");
    await fixture.observe("aku/worker", "body/2", "Bob");
    await fixture.square(async (square) => {
      const snapshot = await square.snapshot();
      for (const notice of notices.filter((item) => item.kind === "say")) {
        assert.equal(snapshot.delivered("Alice", notice.id), false);
        assert.equal(snapshot.delivered("Bob", notice.id), [first.id, failed.id].includes(notice.id));
      }
      const pending = await (await square.participant("Bob")).catch();
      assert.ok(pending.activities.some((item) => item.body?.startsWith("incidental")));
      assert.ok(pending.activities.some((item) => item.actor === "aku/other"));
    });
  });
});

test("answer notices carry the outcome text and are acknowledged by identity", async () => {
  await withSquareNotificationFixture("answer-forms", async (fixture) => {
    await fixture.answeredTurn("aku/forms", 1, 1, "Alice", "first line\nsecond line");
    await fixture.answeredTurn("aku/forms", 1, 2, "Alice", "");
    assert.deepEqual(await fixture.expressions(), [
      captured("aku/forms", "aku/forms turn/1 (@Alice)\nfirst line\nsecond line\nignore if you have already seen this.", ["Alice"]),
      captured("aku/forms", "aku/forms turn/2 (@Alice)\n\nignore if you have already seen this.", ["Alice"]),
    ]);
    await fixture.observe("aku/forms", "turn/1", "Alice");
    await fixture.observe("aku/forms", "turn/2", "Alice");
    await fixture.square(async (square) => {
      const notices = (await square.history({ from: ["aku/forms"], limit: null })).activities
        .filter((activity) => activity.kind === "say");
      const snapshot = await square.snapshot();
      for (const notice of notices) assert.equal(snapshot.delivered("Alice", notice.id), true);
    });
  });
});

test("outcome observation acknowledges every exact duplicate beyond the default history page without joining", async (t) => {
  await withSquareNotificationFixture("ack-full-archive", async (fixture) => {
    const notices = await fixture.square(async (square) => {
      const worker = (await square.implicitJoin("aku/repeated")).participant!;
      const ids: Activity["id"][] = [];
      for (let index = 0; index < 12; index++) {
        const result = await worker.express("aku/repeated turn/1\nack\nignore if you have already seen this.",
          { mentions: ["Alice", "Bob"], noMention: true, force: true });
        ids.push(result.activity.id);
      }
      return ids;
    });
    const forbidJoin = t.mock.method(Square.prototype, "join", async () => { throw new Error("observation must not join"); });
    const forbidImplicitJoin = t.mock.method(Square.prototype, "implicitJoin", async () => { throw new Error("observation must not reenter"); });
    await fixture.observe("aku/repeated", "turn/1", "Bob");
    forbidJoin.mock.restore();
    forbidImplicitJoin.mock.restore();
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
        await (await square.implicitJoin(name)).participant!.listen("aku/listened");
      }
    });
    await fixture.answeredTurn("aku/listened", 1, 1, undefined, "public to listeners");
    const notice = await fixture.square(async (square) =>
      (await square.history({ from: ["aku/listened"], limit: null })).activities.find((item) => item.kind === "say")!);
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
      const notice = (await square.history({ from: ["aku/late"], limit: null })).activities.find((item) => item.kind === "say")!;
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), false);
      const alice = (await square.implicitJoin("Alice")).participant!;
      await alice.done();
    });
    await fixture.observe("aku/late", "turn/1", "Alice");
    await fixture.square(async (square) => {
      const notice = (await square.history({ from: ["aku/late"], limit: null })).activities.find((item) => item.kind === "say")!;
      const snapshot = await square.snapshot();
      assert.equal(snapshot.delivered("Alice", notice.id), false);
      assert.equal(snapshot.participants.find((item) => item.name === "Alice")?.state, "done");
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
    process.env.SQUARE_PARTICIPANT_NAME = "Alice";
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
      const notice = (await square.history({ from: ["aku/local"], limit: null })).activities.find((item) => item.kind === "say")!;
      assert.equal((await square.snapshot()).delivered("Alice", notice.id), false);
      const interrupted = new AbortController();
      const originalHistory = Square.prototype.history;
      const historyMock = t.mock.method(Square.prototype, "history", async function (this: Square,
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
      t.mock.method(square.constructor as typeof Square, "at", async () => { throw new Error("broken Square read"); });
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
      assert.equal((await square.participants()).participants.some(({ name }) => name === "aku/cancel-open"), false);
    });
  });
});

test("Square notifications refuse while held and cancelled expressions cannot land later", async () => {
  await withSquareNotificationFixture("bounded-express", async (fixture) => {
    await fixture.square(async (square) => { await (await square.participant("Alice")).hold("paused"); });
    await assert.rejects(fixture.answeredTurn("aku/held", 1, 1, "Alice", "held"));
    await fixture.square(async (square) => { await (await square.participant("Alice")).resume(); });
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
      captured("aku/same", "aku/same turn/1 (@Alice)\n× failed first\nignore if you have already seen this.", ["Alice"]),
      captured("aku/answered", "aku/answered turn/2 (@Alice)\ndone\nignore if you have already seen this.", ["Alice"]),
      captured("aku/answered", "aku/answered body/2 (@Alice)\n× interrupted: hung: provider custody remained live\nignore if you have already seen this.", ["Alice"]),
      captured("aku/different", "aku/different turn/3 (@Alice)\n× failed for Alice\nignore if you have already seen this.", ["Alice"]),
      captured("aku/different", "aku/different body/3 (@Bob)\n× interrupted: broke-off: different recipient\nignore if you have already seen this.", ["Bob"]),
    ]);
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
      captured("aku/group", "aku/group turn/1 (@Alice)\n× failed\nignore if you have already seen this.", ["Alice", "Bob", "Carol"]),
      captured("aku/group", "aku/group body/1 (@Alice)\n× interrupted: broke-off: stopped\nignore if you have already seen this.", ["Dana"]),
      captured("aku/silent-owner", "aku/silent-owner turn/2\n× failed\nignore if you have already seen this.", ["Bob"]),
      captured("aku/no-audience", "aku/no-audience turn/3 (@Alice)\ndone\nignore if you have already seen this."),
    ]);
  });
});

test("same-Body notifications serialize while distinct Bodies overlap", async () => {
  await withSquareNotificationFixture("serialize", async (fixture) => {
    const failedExpression = captured("aku/same", "aku/same turn/1 (@Alice)\n× failed first\nignore if you have already seen this.", ["Alice"]);
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
    const liveExpression = captured("aku/live-body", "aku/live-body turn/1 (@Bob)\nlive\nignore if you have already seen this.", ["Bob"]);
    const parkedExpression = captured("aku/parked-body", "aku/parked-body turn/1 (@Alice)\n× parked failure\nignore if you have already seen this.", ["Alice"]);
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
        captured("aku/rejected", "aku/rejected body/1 (@Ghost)\n× interrupted: broke-off: route established late\nignore if you have already seen this.", ["Ghost"]),
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
    assert.deepEqual((await fixture.expressions()).filter(({ actor }) => actor === "aku/late"), [
      captured("aku/late", "aku/late turn/1 (@Alice)\n× late failure\nignore if you have already seen this.", ["Alice"]),
      captured("aku/late", "aku/late body/1 (@Alice)\n× interrupted: broke-off: after timeout\nignore if you have already seen this.", ["Alice"]),
    ]);
  });
});

test("Turn mentions follow the signal initiator, never the Body environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-initiator-"));
  const prior = {
    SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
    SQUARE_HOST_LEDGER_ROOT: process.env.SQUARE_HOST_LEDGER_ROOT,
  };
  try {
    process.env.SQUARE_HOST_LEDGER_ROOT = join(root, "square-ledger");
    mkdirSync(join(root, ".square"), { recursive: true });
    for (const initiator of ["Alice", "Bob"]) {
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
        {
          actor: "aku/worker",
          body: "aku/worker turn/1 (@Alice)\n× fixture failure\nignore if you have already seen this.",
          mentions: ["Alice"],
        },
        {
          actor: "aku/worker",
          body: "aku/worker turn/2 (@Bob)\n× fixture failure\nignore if you have already seen this.",
          mentions: ["Bob"],
        },
        {
          actor: "aku/worker",
          body: "aku/worker turn/3\n× fixture failure\nignore if you have already seen this.",
          mentions: [],
        },
      ],
    );
  } finally {
    restoreEnvironmentValues(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Pi caller registration and outcomes share the harness ledger across execution directories", async () => {
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
    const initiator = squareAssignedParticipantName(callerEnv)!;
    const submitter = await activateSquare(world);
    const initiating = submitter.signals?.["akuma.initiating"];
    assert.ok(initiating);
    await initiating({ kind: "akuma.initiating", initiator });

    // A native harness creates its own ledger port, not the plugin's captured port.
    const ledger = createHostLedgerPort();
    const bindings = await ledger.listPresence({ session: callerEnv.PI_SESSION_ID! });
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.location, realpathSync(squarePath(world)));
    assert.equal(bindings[0]?.participant, initiator);
    assert.equal(existsSync(join(cwd, ".square", "host-ledger")), false);

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

    const square = await Square.at({ path: bindings[0]!.location, env: callerEnv, hostLedger: ledger });
    try {
      const joined = await square.implicitJoin(initiator);
      assert.ok(joined.participant);
      const caught = await joined.participant.catch();
      assert.ok(caught.activities.some((item) => item.body?.includes("\ndone\n")));
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
    const former = squareAssignedParticipantName(serving)!;
    assert.match(former, /^pi-/u);
    process.env.PI_SESSION_ID = "elsewhere";
    const elsewhere = await Square.at({ path: squarePath(root), env: { ...process.env } });
    try {
      await elsewhere.implicitJoin(former);
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
      const notices = (await square.history({ from: ["aku/seat"], limit: null })).activities
        .filter((activity) => activity.kind === "say");
      const seatNotice = notices.find((notice) => notice.body?.startsWith("aku/seat turn/1"))!;
      const formerNotice = notices.find((notice) => notice.body?.startsWith("aku/seat turn/2"))!;
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
      const notice = (await square.history({ from: ["aku/forwarded"], limit: null })).activities
        .find((activity) => activity.kind === "say")!;
      assert.equal((await square.snapshot()).delivered("Forwarded", notice.id), true, "the forwarded requester is served");
      assert.equal((await square.snapshot()).delivered(seat, notice.id), false, "the serving session is not the observer");
    } finally {
      await square.close();
    }
    const bindings = await createHostLedgerPort().listPresence({ session: serving.PI_SESSION_ID! });
    assert.deepEqual(
      bindings.map(({ participant }) => participant),
      [seat],
      "the serving session keeps its own single binding and gains nothing from forwarding",
    );
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
    const joined = await Square.build({ path: squarePath(root), markdown: "", env: { ...process.env } });
    try {
      await (await joined.implicitJoin("Stale")).participant?.catch();
      await (await joined.implicitJoin("Declared")).participant?.catch();
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
      const notices = (await square.history({ from: ["aku/explicit"], limit: null })).activities
        .filter((activity) => activity.kind === "say");
      const snapshot = await square.snapshot();
      const declaredNotice = notices.find((notice) => notice.body?.startsWith("aku/explicit turn/1"))!;
      const staleNotice = notices.find((notice) => notice.body?.startsWith("aku/explicit turn/2"))!;
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
