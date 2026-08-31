import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-plugin-runtime-"));
  const home = join(root, "home");
  const plugins = join(root, "plugins");
  mkdirSync(home, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  return {
    root,
    home,
    plugins,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writePlugin(root: string, name: string, source: string): void {
  writeFileSync(join(root, "plugins", `${name}.mjs`), source);
}

function trace(path: string): readonly string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

test("plugin runtime selects project-shadowed enabled plugins in manifest-id order", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "alpha",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "alpha", apiVersion: 1 },',
        '  activate(context) { appendFileSync(context.config.trace, `activate:${context.config.label}\\n`); return { signals: { "akuma.turn-outcome": (signal) => appendFileSync(context.config.trace, `signal:${signal.akumaId}:${signal.turnSequence}\\n`) } }; },',
        "};",
      ].join("\n"),
    );
    writePlugin(
      value.root,
      "beta",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "beta", apiVersion: 1 },',
        "  activate(context) { appendFileSync(context.config.trace, `activate:${context.config.label}\\n`); return {}; },",
        "};",
      ].join("\n"),
    );
    writeFileSync(
      join(value.home, "settings.json"),
      JSON.stringify({
        plugins: {
          alpha: { package: "./plugins/missing-user-alpha.mjs", config: { trace: output, label: "user-alpha" } },
          disabled: { package: "./plugins/missing-disabled.mjs", enabled: false },
        },
      }),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          alpha: { package: "./plugins/alpha.mjs", config: { trace: output, label: "project-alpha" } },
          beta: { package: "./plugins/beta.mjs", config: { trace: output, label: "beta" } },
        },
      }),
    );

    const world = await World.at(value.root);
    const diagnostics: string[] = [];
    const runtime = await pluginRuntime({
      world,
      settings: await settings({ root: value.root, home: value.home }),
      reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    await runtime.emit({
      kind: "akuma.turn-outcome",
      akumaId: "aku/example",
      turnSequence: 2,
      outcome: { kind: "answered", text: "done" },
      contractId: "kei/example",
    });

    assert.deepEqual(trace(output), ["activate:project-alpha", "activate:beta", "signal:aku/example:2"]);
    assert.deepEqual(diagnostics, []);
  } finally {
    value.close();
  }
});

test("plugin activation stages handlers and isolates import and activation failures", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "broken",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "broken", apiVersion: 1 },',
        '  activate(context) { appendFileSync(context.config.trace, "broken-activation\\n"); return { signals: { "akuma.turn-outcome": "not-a-handler" } }; },',
        "};",
      ].join("\n"),
    );
    writePlugin(
      value.root,
      "working",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "working", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.turn-outcome": () => appendFileSync(context.config.trace, "working-signal\\n") } }; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          broken: { package: "./plugins/broken.mjs", config: { trace: output } },
          missing: { package: "./plugins/not-found.mjs" },
          working: { package: "./plugins/working.mjs", config: { trace: output } },
        },
      }),
    );

    const diagnostics: string[] = [];
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (value) => diagnostics.push(value),
    });
    await runtime.emit({
      kind: "akuma.turn-outcome",
      akumaId: "aku/example",
      turnSequence: 1,
      outcome: { kind: "failed", reason: "no" },
    });

    assert.deepEqual(trace(output), ["broken-activation", "working-signal"]);
    assert.equal(
      diagnostics.some((value) => value.startsWith("plugin broken activation:")),
      true,
    );
    assert.equal(
      diagnostics.some((value) => value.startsWith("plugin missing import:")),
      true,
    );
  } finally {
    value.close();
  }
});

test("plugin runtime resolves bare package exports with the ESM import condition", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    const packageRoot = join(value.root, "node_modules", "conditional-plugin");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ type: "module", exports: { import: "./import.mjs", require: "./require.cjs" } }),
    );
    writeFileSync(
      join(packageRoot, "import.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "conditional", apiVersion: 1 },',
        '  activate(context) { appendFileSync(context.config.trace, "import\\n"); return {}; },',
        "};",
      ].join("\n"),
    );
    writeFileSync(
      join(packageRoot, "require.cjs"),
      [
        'const { appendFileSync } = require("node:fs");',
        "module.exports = {",
        '  manifest: { id: "conditional", apiVersion: 1 },',
        '  activate(context) { appendFileSync(context.config.trace, "require\\n"); return {}; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({ plugins: { conditional: { package: "conditional-plugin", config: { trace: output } } } }),
    );

    await pluginRuntime({ world: await World.at(value.root) });

    assert.deepEqual(trace(output), ["import"]);
  } finally {
    value.close();
  }
});

test("plugin delivery starts generic call handlers independently and contains handler failure", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "alpha",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "alpha", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.called": async () => { appendFileSync(context.config.trace, "slow-start\\n"); await new Promise((resolve) => setTimeout(resolve, 25)); appendFileSync(context.config.trace, "slow-fail\\n"); throw new Error("handler failed"); } } }; },',
        "};",
      ].join("\n"),
    );
    writePlugin(
      value.root,
      "beta",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "beta", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.called": (signal) => appendFileSync(context.config.trace, `fast:${signal.akumaId}\\n`) } }; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          alpha: { package: "./plugins/alpha.mjs", config: { trace: output } },
          beta: { package: "./plugins/beta.mjs", config: { trace: output } },
        },
      }),
    );

    const diagnostics: string[] = [];
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (value) => diagnostics.push(value),
    });
    await runtime.emit({ kind: "akuma.called", akumaId: "aku/example" });

    assert.deepEqual(trace(output), ["slow-start", "fast:aku/example", "slow-fail"]);
    assert.equal(
      diagnostics.some((value) => value.startsWith("plugin alpha signal: handler failed")),
      true,
    );
  } finally {
    value.close();
  }
});

test("cached plugin handlers report each signal failure to its own diagnostic callback", async () => {
  const value = fixture();
  try {
    writePlugin(
      value.root,
      "failing",
      [
        "export default {",
        '  manifest: { id: "failing", apiVersion: 1 },',
        '  activate() { return { signals: { "akuma.called": () => { throw new Error("handler failed"); } } }; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({ plugins: { failing: { package: "./plugins/failing.mjs" } } }),
    );

    const first: string[] = [];
    const second: string[] = [];
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (diagnostic) => first.push(diagnostic),
    });
    await runtime.emit({ kind: "akuma.called", akumaId: "aku/first" });
    await runtime.emit({ kind: "akuma.called", akumaId: "aku/second" }, (diagnostic) => second.push(diagnostic));

    assert.deepEqual(first, ["plugin failing signal: handler failed"]);
    assert.deepEqual(second, ["plugin failing signal: handler failed"]);
  } finally {
    value.close();
  }
});

test("plugin writable paths reject traversal, management custody, duplicate names, and symlink escape", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    const outside = join(value.root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(value.root, "linked"), "dir");
    const invalid = (id: string, writablePaths: string) =>
      [
        "export default {",
        `  manifest: { id: "${id}", apiVersion: 1, writablePaths: ${writablePaths} },`,
        "  activate() { throw new Error('must not activate'); },",
        "};",
      ].join("\n");
    writePlugin(value.root, "traversal", invalid("traversal", '[{ name: "state", path: "../escape" }]'));
    writePlugin(value.root, "reserved", invalid("reserved", '[{ name: "state", path: ".keiyaku/plugin" }]'));
    writePlugin(value.root, "case", invalid("case", '[{ name: "state", path: ".KEIYAKU/plugin" }]'));
    writePlugin(
      value.root,
      "duplicate",
      invalid("duplicate", '[{ name: "state", path: "one" }, { name: "state", path: "two" }]'),
    );
    writePlugin(value.root, "symlink", invalid("symlink", '[{ name: "state", path: "linked/escape" }]'));
    writePlugin(
      value.root,
      "valid",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "valid", apiVersion: 1, writablePaths: [{ name: "square", path: ".square" }] },',
        '  activate(context) { appendFileSync(context.config.trace, `${context.writablePath("square")}\\n`); try { context.writablePath("missing"); } catch { appendFileSync(context.config.trace, "undeclared\\n"); } return {}; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          case: { package: "./plugins/case.mjs" },
          duplicate: { package: "./plugins/duplicate.mjs" },
          reserved: { package: "./plugins/reserved.mjs" },
          symlink: { package: "./plugins/symlink.mjs" },
          traversal: { package: "./plugins/traversal.mjs" },
          valid: { package: "./plugins/valid.mjs", config: { trace: output } },
        },
      }),
    );

    const world = await World.at(value.root);
    const diagnostics: string[] = [];
    await pluginRuntime({ world, reportDiagnostic: (value) => diagnostics.push(value) });

    assert.deepEqual(trace(output), [join(world, ".square"), "undeclared"]);
    assert.equal(existsSync(join(outside, "escape")), false);
    for (const id of ["case", "duplicate", "reserved", "symlink", "traversal"]) {
      assert.equal(
        diagnostics.some((value) => value.startsWith(`plugin ${id} validation:`)),
        true,
      );
    }
  } finally {
    value.close();
  }
});
