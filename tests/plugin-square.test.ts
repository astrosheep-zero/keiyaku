import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Square } from "@astrosheep/square";
import squarePlugin from "../plugins/square/index.js";
import type { WorldRoot } from "../src/world.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { World } from "../src/world.js";

const squarePath = (root: string): string => join(root, ".square", "KEIYAKU.square");

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
  const prior = {
    CODEX_THREAD_ID: process.env.CODEX_THREAD_ID,
    SQUARE_PARTICIPANT_NAME: process.env.SQUARE_PARTICIPANT_NAME,
    SQUARE_HOST_LEDGER_LOCAL: process.env.SQUARE_HOST_LEDGER_LOCAL,
    SQUARE_HOST_LEDGER_USER: process.env.SQUARE_HOST_LEDGER_USER,
  };
  try {
    assert.deepEqual(squarePlugin.manifest, {
      id: "square",
      apiVersion: 1,
      writablePaths: [{ name: "square", path: ".square" }],
    });
    mkdirSync(join(root, ".square"), { recursive: true });
    process.env.CODEX_THREAD_ID = "caller";
    process.env.SQUARE_PARTICIPANT_NAME = "Alice";
    process.env.SQUARE_HOST_LEDGER_LOCAL = join(root, "local-ledger");
    process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
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
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
      turnSequence: 1,
      outcome: { kind: "answered", text: "done" },
      contractId: "kei/example",
    });
    await handler({
      kind: "akuma.turn-outcome",
      akumaId: "aku/answered",
      turnSequence: 2,
      outcome: { kind: "answered", text: "adjusted" },
      contractId: "kei/example",
    });
    assert.equal(existsSync(squarePath(root)), true);
    assert.deepEqual(await expressions(squarePath(root)), [
      { actor: "Alice", body: "aku/caller called aku/called\nignore if you have already seen this.", mentions: [] },
      { actor: "aku/answered", body: "aku/answered turn/1 (@Alice) kei/example\n✓ came back\nignore if you have already seen this.", mentions: ["Alice"] },
      { actor: "aku/answered", body: "aku/answered turn/2 (@Alice) kei/example\n✓ came back\nignore if you have already seen this.", mentions: ["Alice"] },
    ]);

    delete process.env.CODEX_THREAD_ID;
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
      { actor: "aku/answered", body: "aku/answered turn/1 (@Alice) kei/example\n✓ came back\nignore if you have already seen this.", mentions: ["Alice"] },
      { actor: "aku/answered", body: "aku/answered turn/2 (@Alice) kei/example\n✓ came back\nignore if you have already seen this.", mentions: ["Alice"] },
      { actor: "aku/failed", body: "aku/failed turn/3\n× provider failed\nignore if you have already seen this.", mentions: [] },
    ]);
    const square = await Square.at({ path: squarePath(root) });
    try {
      assert.deepEqual((await square.participants()).map(({ name }) => name).sort(), [
        "Alice",
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

test("the host isolates a Square plugin handler failure", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-plugin-square-isolation-"));
  const prior = {
    SQUARE_HOST_LEDGER_LOCAL: process.env.SQUARE_HOST_LEDGER_LOCAL,
    SQUARE_HOST_LEDGER_USER: process.env.SQUARE_HOST_LEDGER_USER,
  };
  try {
    mkdirSync(join(root, ".keiyaku"), { recursive: true });
    mkdirSync(join(root, "plugins"), { recursive: true });
    process.env.SQUARE_HOST_LEDGER_LOCAL = join(root, "local-ledger");
    process.env.SQUARE_HOST_LEDGER_USER = join(root, "user-ledger");
    writeFileSync(
      join(root, "plugins", "square.mjs"),
      `export { default } from ${JSON.stringify(new URL("../plugins/square/index.js", import.meta.url).href)};\n`,
    );
    writeFileSync(
      join(root, ".keiyaku", "settings.json"),
      JSON.stringify({ plugins: { square: { package: "./plugins/square.mjs" } } }),
    );
    t.mock.method(Square.prototype, "implicitJoin", async () => {
      throw new Error("injected Square failure");
    });
    const diagnostics: string[] = [];
    const runtime = await pluginRuntime({
      world: await World.at(root),
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const signal = {
      kind: "akuma.turn-outcome" as const,
      akumaId: "aku/failed",
      turnSequence: 1,
      outcome: { kind: "failed" as const, reason: "provider failed" },
    };
    for (let attempt = 0; attempt < 100 && diagnostics.length === 0; attempt += 1) {
      await runtime.emit(signal);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      diagnostics.some((diagnostic) => diagnostic.startsWith("plugin square signal: injected Square failure")),
      true,
    );
  } finally {
    restoreEnvironment(prior);
    rmSync(root, { recursive: true, force: true });
  }
});
