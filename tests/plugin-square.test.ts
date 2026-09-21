import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Square } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import type { PluginHooks } from "../src/plugin/public.js";
import type { WorldRoot } from "../src/world.js";
import { deferred as promiseBarrier } from "./support/process.js";

const squarePath = (root: string): string => join(root, ".square", "KEIYAKU.square");

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

function restoreEnvironment(values: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
async function expressions(
  path: string,
): Promise<readonly Readonly<{ actor: string; body: string; mentions: readonly string[] }>[]> {
  const square = await Square.at({ path });
  try {
    return (await square.history()).flatMap((activity) =>
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
  Square.prototype.implicitJoin = async function (name: string) {
    const joined = await originalImplicitJoin.call(this, name);
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
  ): Promise<void>;
  answeredTurn(
    akumaId: string,
    bodySequence: number,
    turnSequence: number,
    initiator: string | undefined,
    text: string,
    cancellation?: AbortSignal,
  ): Promise<void>;
  bodyEnd(
    akumaId: string,
    bodySequence: number,
    end: BodyEndDetails["end"],
    initiator?: string,
    diagnostic?: string,
    cancellation?: AbortSignal,
  ): Promise<void>;
  expressions(): Promise<readonly CapturedExpression[]>;
  bodies(): Promise<readonly string[]>;
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
    SQUARE_HOST_LEDGER_LOCAL: process.env.SQUARE_HOST_LEDGER_LOCAL,
    SQUARE_HOST_LEDGER_USER: process.env.SQUARE_HOST_LEDGER_USER,
  };
  try {
    mkdirSync(join(root, ".square"), { recursive: true });
    process.env.SQUARE_HOST_LEDGER_LOCAL = join(root, "local-ledger");
    process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
    const instance = await squarePlugin.activate({
      world: root as WorldRoot,
      config: undefined,
      writablePath: () => join(root, ".square"),
    });
    const turn = instance.signals?.["akuma.turn-outcome"];
    const bodyEnd = instance.signals?.["akuma.body-ended"];
    const initiating = instance.signals?.["akuma.initiating"];
    assert.ok(turn);
    assert.ok(bodyEnd);
    assert.ok(initiating);
    const fixture: SquareNotificationFixture = {
      async admit(initiator) {
        await initiating({ kind: "akuma.initiating", initiator });
      },
      async failedTurn(akumaId, bodySequence, turnSequence, initiator, reason, cancellation) {
        await turn(
          {
            kind: "akuma.turn-outcome",
            akumaId,
            bodySequence,
            turnSequence,
            ...optionalInitiator(initiator),
            outcome: { kind: "failed", reason },
          },
          cancellation,
        );
      },
      async answeredTurn(akumaId, bodySequence, turnSequence, initiator, text, cancellation) {
        await turn(
          {
            kind: "akuma.turn-outcome",
            akumaId,
            bodySequence,
            turnSequence,
            ...optionalInitiator(initiator),
            outcome: { kind: "answered", text },
          },
          cancellation,
        );
      },
      async bodyEnd(akumaId, bodySequence, end, initiator, diagnostic, cancellation) {
        await bodyEnd(
          {
            kind: "akuma.body-ended",
            akumaId,
            bodySequence,
            end,
            ...optionalInitiator(initiator),
            ...optionalDiagnostic(diagnostic),
          },
          cancellation,
        );
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
    restoreEnvironment(prior);
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
    SQUARE_HOST_LEDGER_LOCAL: process.env.SQUARE_HOST_LEDGER_LOCAL,
    SQUARE_HOST_LEDGER_USER: process.env.SQUARE_HOST_LEDGER_USER,
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
    process.env.SQUARE_HOST_LEDGER_LOCAL = join(root, "local-ledger");
    process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
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
    const instance = await squarePlugin.activate({
      world: root as unknown as WorldRoot,
      config: undefined,
      writablePath: () => join(root, ".square"),
    });
    const handler = instance.signals?.["akuma.turn-outcome"];
    assert.ok(handler);
    assert.ok(instance.signals?.["akuma.body-ended"]);
    const called = instance.signals?.["akuma.called"];
    assert.ok(called);
    await called({
      kind: "akuma.called",
      akumaId: "aku/called",
      callerAkumaId: "aku/caller",
      contractId: "kei/example",
    });
    process.env.CODEX_THREAD_ID = "teller";
    process.env.SQUARE_PARTICIPANT_NAME = "Bob";
    const teller = await squarePlugin.activate({
      world: root as WorldRoot,
      config: undefined,
      writablePath: () => join(root, ".square"),
    });
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
      outcome: { kind: "answered", text: "done" },
      contractId: "kei/example",
    });
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
      bodySequence: 1,
      turnSequence: 2,
      initiator: "Bob",
      outcome: { kind: "answered", text: "adjusted" },
      contractId: "kei/example",
    });
    assert.equal(existsSync(squarePath(root)), true);
    assert.deepEqual(await expressions(squarePath(root)), [
      { actor: "Alice", body: "aku/caller called aku/called\nignore if you have already seen this.", mentions: [] },
      {
        actor: "aku/answered",
        body: "aku/answered turn/1 (@Alice) kei/example\n✓ came back\nignore if you have already seen this.",
        mentions: ["Alice"],
      },
      {
        actor: "aku/answered",
        body: "aku/answered turn/2 (@Bob) kei/example\n✓ came back\nignore if you have already seen this.",
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
      assert.match(queued[0]?.at(-1) ?? "", /attention: act\/\d+ for Alice from aku\/answered/u);
      const evidence = readFileSync(join(root, "user-ledger", "evidence.ndjsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; outcome: string; participant: string });
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
    const fallback = await squarePlugin.activate({
      world: root as unknown as WorldRoot,
      config: undefined,
      writablePath: () => join(root, ".square"),
    });
    const fallbackHandler = fallback.signals?.["akuma.turn-outcome"];
    assert.ok(fallbackHandler);
    assert.ok(fallback.signals?.["akuma.body-ended"]);
    const externalCalled = fallback.signals?.["akuma.called"];
    assert.ok(externalCalled);
    await externalCalled({ kind: "akuma.called", akumaId: "aku/external" });
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
        body: "aku/answered turn/1 (@Alice) kei/example\n✓ came back\nignore if you have already seen this.",
        mentions: ["Alice"],
      },
      {
        actor: "aku/answered",
        body: "aku/answered turn/2 (@Bob) kei/example\n✓ came back\nignore if you have already seen this.",
        mentions: ["Bob"],
      },
      {
        actor: "aku/failed",
        body: "aku/failed turn/3\n× provider failed\nignore if you have already seen this.",
        mentions: [],
      },
    ]);
    const square = await Square.at({ path: squarePath(root) });
    try {
      assert.deepEqual((await square.participants()).map(({ name }) => name).sort(), [
        "Alice",
        "Bob",
        "aku/answered",
        "aku/failed",
      ]);
    } finally {
      await square.close();
    }
  } finally {
    restoreEnvironment(prior);
    rmSync(root, { recursive: true, force: true });
  }
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
      captured("aku/answered", "aku/answered turn/2 (@Alice)\n✓ came back\nignore if you have already seen this.", ["Alice"]),
      captured("aku/answered", "aku/answered body/2 (@Alice)\n× interrupted: hung: provider custody remained live\nignore if you have already seen this.", ["Alice"]),
      captured("aku/different", "aku/different turn/3 (@Alice)\n× failed for Alice\nignore if you have already seen this.", ["Alice"]),
      captured("aku/different", "aku/different body/3 (@Bob)\n× interrupted: broke-off: different recipient\nignore if you have already seen this.", ["Bob"]),
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
    const liveExpression = captured("aku/live-body", "aku/live-body turn/1 (@Bob)\n✓ came back\nignore if you have already seen this.", ["Bob"]);
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
  const prior = { SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME };
  try {
    mkdirSync(join(root, ".square"), { recursive: true });
    for (const initiator of ["Alice", "Bob"]) {
      process.env.SQUARE_PARTICIPANT_NAME = initiator;
      const submitter = await squarePlugin.activate({
        world: root as WorldRoot,
        config: undefined,
        writablePath: () => join(root, ".square"),
      });
      await submitter.signals?.["akuma.initiating"]?.({ kind: "akuma.initiating", initiator });
    }
    process.env.SQUARE_PARTICIPANT_NAME = "OriginalCaller";
    const instance = await squarePlugin.activate({
      world: root as WorldRoot,
      config: undefined,
      writablePath: () => join(root, ".square"),
    });
    const handler = instance.signals?.["akuma.turn-outcome"];
    assert.ok(handler);
    for (const [index, initiator] of ["Alice", "Bob", undefined].entries()) {
      await handler({
        kind: "akuma.turn-outcome",
        akumaId: "aku/worker",
        bodySequence: 1,
        turnSequence: index + 1,
        ...(initiator === undefined ? {} : { initiator }),
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
    restoreEnvironment(prior);
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Square plugin uses the submitting cwd without PWD and honors a local-ledger override", async () => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-square-pwd-"));
  const world = join(root, "world");
  const cwd = join(root, "execution");
  const priorCwd = process.cwd();
  const prior = {
    PWD: process.env.PWD,
    SQUARE_REGISTRY: process.env.SQUARE_REGISTRY,
    SQUARE_HOST_LEDGER_LOCAL: process.env.SQUARE_HOST_LEDGER_LOCAL,
    SQUARE_HOST_LEDGER_USER: process.env.SQUARE_HOST_LEDGER_USER,
    SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
  };
  try {
    mkdirSync(join(world, ".square"), { recursive: true });
    mkdirSync(cwd);
    process.chdir(cwd);
    delete process.env.PWD;
    delete process.env.SQUARE_REGISTRY;
    delete process.env.SQUARE_HOST_LEDGER_LOCAL;
    process.env.SQUARE_PARTICIPANT_NAME = "fixture-no-pwd";
    process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
    const instance = await squarePlugin.activate({
      world: world as unknown as WorldRoot,
      config: undefined,
      writablePath: () => join(world, ".square"),
    });
    const handler = instance.signals?.["akuma.called"];
    assert.ok(handler);
    await handler({
      kind: "akuma.called",
      akumaId: "aku/pwd-local",
    });
    const presence = join(cwd, ".square", "host-ledger", "presence.ndjsonl");
    assert.equal(existsSync(presence), true);
    assert.match(readFileSync(presence, "utf8"), /fixture-no-pwd/u);
    assert.equal(existsSync(join(world, ".square", ".square", "host-ledger")), false);
    assert.equal(existsSync(squarePath(world)), true);
    assert.equal(existsSync(squarePath(cwd)), false);

    const override = join(root, "override-ledger");
    process.env.SQUARE_HOST_LEDGER_LOCAL = override;
    process.env.SQUARE_PARTICIPANT_NAME = "fixture-override";
    const overridden = await squarePlugin.activate({
      world: world as unknown as WorldRoot,
      config: undefined,
      writablePath: () => join(world, ".square"),
    });
    const overrideHandler = overridden.signals?.["akuma.called"];
    assert.ok(overrideHandler);
    await overrideHandler({
      kind: "akuma.called",
      akumaId: "aku/override-local",
    });
    const overridePresence = join(override, "presence.ndjsonl");
    assert.equal(existsSync(overridePresence), true);
    assert.match(readFileSync(overridePresence, "utf8"), /fixture-override/u);
  } finally {
    process.chdir(priorCwd);
    restoreEnvironment(prior);
    rmSync(root, { recursive: true, force: true });
  }
});
