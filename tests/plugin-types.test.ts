import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("package root and plugin subpath expose the typed plugin contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-plugin-types-"));
  try {
    mkdirSync(join(directory, "node_modules", "@astrosheep"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules", "@astrosheep", "keiyaku"), "dir");
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(directory, "consumer.ts"),
      [
        'import type { KeiyakuPlugin as RootPlugin, PluginContext as RootContext, PluginHooks as RootHooks, PluginSignal as RootSignal } from "@astrosheep/keiyaku";',
        'import type { KeiyakuPlugin, PluginContext, PluginHooks, PluginSignal } from "@astrosheep/keiyaku/plugin";',
        "const rootPlugin = null as unknown as RootPlugin;",
        "const plugin: KeiyakuPlugin = rootPlugin;",
        "const rootContext = null as unknown as RootContext;",
        "const context: PluginContext = rootContext;",
        "const rootSignal = null as unknown as RootSignal;",
        "const signal: PluginSignal = rootSignal;",
        "const hooks: PluginHooks = {",
        '  "akuma.turn-outcome": (turn) => {',
        "    turn.turnSequence.toFixed();",
        '    if (turn.outcome.kind === "answered") turn.outcome.text.toUpperCase();',
        "    else turn.outcome.reason.toUpperCase();",
        "  },",
        "};",
        "const rootHooks = hooks as RootHooks;",
        "void plugin; void context; void signal; void rootHooks;",
      ].join("\n"),
    );
    execFileSync(
      process.execPath,
      [
        join(root, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--strict",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--skipLibCheck",
        "consumer.ts",
      ],
      { cwd: directory, stdio: "ignore" },
    );
    assert.ok(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
