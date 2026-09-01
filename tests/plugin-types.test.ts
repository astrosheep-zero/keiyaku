import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("package root, plugin subpath, and Square plugin expose the typed plugin contract", () => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-plugin-types-"));
  try {
    mkdirSync(join(directory, "node_modules", "@astrosheep"), { recursive: true });
    mkdirSync(join(directory, "node_modules", "@types"), { recursive: true });
    symlinkSync(root, join(directory, "node_modules", "@astrosheep", "keiyaku"), "dir");
    symlinkSync(
      join(root, "plugins", "square"),
      join(directory, "node_modules", "@astrosheep", "keiyaku-plugin-square"),
      "dir",
    );
    symlinkSync(join(root, "node_modules", "@types", "node"), join(directory, "node_modules", "@types", "node"), "dir");
    symlinkSync(join(root, "node_modules", "undici-types"), join(directory, "node_modules", "undici-types"), "dir");
    writeFileSync(join(directory, "package.json"), '{"type":"module"}\n');
    writeFileSync(
      join(directory, "consumer.ts"),
      [
        'import type { KeiyakuPlugin as RootPlugin, PluginContext as RootContext, PluginHooks as RootHooks, PluginSignal as RootSignal } from "@astrosheep/keiyaku";',
        'import type { KeiyakuPlugin, PluginContext, PluginHooks, PluginSignal } from "@astrosheep/keiyaku/plugin";',
        'import squarePlugin from "@astrosheep/keiyaku-plugin-square";',
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
        "const installedPlugin: RootPlugin = squarePlugin;",
        "void plugin; void context; void signal; void rootHooks; void installedPlugin;",
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
        "--preserveSymlinks",
        "consumer.ts",
      ],
      { cwd: directory, stdio: "ignore" },
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'const plugin = (await import("@astrosheep/keiyaku-plugin-square")).default; if (plugin.manifest.id !== "square") process.exit(1);',
      ],
      { cwd: directory, stdio: "ignore" },
    );
    execFileSync(
      process.execPath,
      [
        "--input-type=commonjs",
        "--eval",
        'const { basename } = require("node:path"); if (basename(require.resolve("@astrosheep/keiyaku-plugin-square")) !== "index.js") process.exit(1);',
      ],
      { cwd: directory, stdio: "ignore" },
    );
    assert.ok(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
