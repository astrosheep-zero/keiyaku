import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

function diagnosticText(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  });
}

test("package root, plugin subpath, and Square plugin expose the typed plugin contract", async () => {
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
    const consumer = join(directory, "consumer.ts");
    writeFileSync(
      consumer,
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
    const program = ts.createProgram([consumer], {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      preserveSymlinks: true,
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(diagnostics.length, 0, diagnosticText(diagnostics));

    const runtime = join(directory, "runtime.mjs");
    writeFileSync(
      runtime,
      'import plugin from "@astrosheep/keiyaku-plugin-square"; if (plugin.manifest.id !== "square") throw new Error("wrong plugin");\n',
    );
    await import(pathToFileURL(runtime).href);

    const requireFromConsumer = createRequire(join(directory, "consumer.cjs"));
    assert.equal(basename(requireFromConsumer.resolve("@astrosheep/keiyaku-plugin-square")), "index.js");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
