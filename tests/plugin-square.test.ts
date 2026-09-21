import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Square } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import type { WorldRoot } from "../src/world.js";

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
    assert.equal(instance.signals?.["akuma.body-ended"], undefined);
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
      turnSequence: 1,
      initiator: "Alice",
      outcome: { kind: "answered", text: "done" },
      contractId: "kei/example",
    });
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
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
    assert.equal(fallback.signals?.["akuma.body-ended"], undefined);
    const externalCalled = fallback.signals?.["akuma.called"];
    assert.ok(externalCalled);
    await externalCalled({ kind: "akuma.called", akumaId: "aku/external" });
    await fallbackHandler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/failed",
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
