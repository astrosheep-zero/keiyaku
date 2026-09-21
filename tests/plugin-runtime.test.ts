import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";

const SQUARE_SESSION_ENVIRONMENT = [
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_THREAD_ID",
  "OPENCODE_SESSION_ID",
  "PI_SESSION_ID",
  "SQUARE_PARTICIPANT_NAME",
  "PASEO_AGENT_ID",
] as const;

function isolateSquareSessionEnvironment(): () => void {
  const previous = new Map(SQUARE_SESSION_ENVIRONMENT.map((name) => [name, process.env[name]]));
  for (const name of SQUARE_SESSION_ENVIRONMENT) delete process.env[name];
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "keiyaku-plugin-runtime-"));
  const home = join(root, "home");
  const plugins = join(root, "plugins");
  const restoreSquareSessionEnvironment = isolateSquareSessionEnvironment();
  mkdirSync(home, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  return {
    root,
    home,
    plugins,
    close: () => {
      restoreSquareSessionEnvironment();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writePlugin(root: string, name: string, source: string): void {
  writeFileSync(join(root, "plugins", `${name}.mjs`), source);
}

function trace(path: string): readonly string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for plugin effect");
    // Real I/O readiness must still progress when an individual test controls deadlines.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// Keep the monotonic budget and its timers on the same clock. Readiness polling
// uses real Date/setImmediate, so a missing effect fails instead of hanging on fake time.
function deadlineClock(context: TestContext): (milliseconds: number) => void {
  let now = 0;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  context.mock.method(performance, "now", () => now);
  return (milliseconds) => {
    now += milliseconds;
    context.mock.timers.tick(milliseconds);
  };
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
    await eventually(() => trace(output).includes("activate:beta"));
    await runtime.emit({
      kind: "akuma.turn-outcome",
      akumaId: "aku/example",
      bodySequence: 1,
      turnSequence: 2,
      outcome: { kind: "answered", text: "done" },
      contractId: "kei/example",
    });

    await eventually(() => trace(output).includes("signal:aku/example:2"));
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
    await eventually(() => trace(output).includes("broken-activation"));
    await runtime.emit({
      kind: "akuma.turn-outcome",
      akumaId: "aku/example",
      bodySequence: 1,
      turnSequence: 1,
      outcome: { kind: "failed", reason: "no" },
    });

    await eventually(() => trace(output).includes("working-signal"));
    assert.deepEqual(trace(output), ["broken-activation", "working-signal"]);
    await eventually(() => diagnostics.some((value) => value.startsWith("plugin missing import:")));
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

    await eventually(() => trace(output).includes("import"));
    assert.deepEqual(trace(output), ["import"]);
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

    await eventually(() => trace(output).includes("undeclared"));
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

test("hanging activation is bounded independently and does not replay an emission", { timeout: 5_000 }, async (context) => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "hanging",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "hanging", apiVersion: 1 },',
        '  activate(context, cancellation) { appendFileSync(context.config.trace, "activation-started\\n"); return new Promise((resolve) => cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, "activation-aborted\\n"); resolve({}); }, { once: true })); },',
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
        '  activate(context) { appendFileSync(context.config.trace, "activated\\n"); return { signals: { "akuma.called": () => appendFileSync(context.config.trace, "called\\n") } }; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          hanging: { package: "./plugins/hanging.mjs", config: { trace: output } },
          working: { package: "./plugins/working.mjs", config: { trace: output } },
        },
      }),
    );

    const diagnostics: string[] = [];
    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (value) => diagnostics.push(value),
    });
    await eventually(() => trace(output).includes("activated"));
    assert.deepEqual(trace(output), ["activation-started", "activated"]);
    // The emission starts after activation and therefore owns a later deadline.
    advance(1);
    const emission = runtime.emit({ kind: "akuma.called", akumaId: "aku/example" }, (value) => diagnostics.push(value));
    await new Promise<void>((resolve) => setImmediate(resolve));
    advance(4_998);
    assert.deepEqual(trace(output), ["activation-started", "activated"]);
    advance(1);
    await emission;
    assert.deepEqual(trace(output), ["activation-started", "activated", "activation-aborted", "called"]);
    assert.equal(
      diagnostics.some((value) => value.startsWith("plugin hanging activation: timed out after 5000ms")),
      true,
    );
  } finally {
    value.close();
  }
});

test("hanging handler is cancelled at the delivery bound without blocking another handler", { timeout: 5_000 }, async (context) => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "hanging",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "hanging", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.called": (_signal, cancellation) => new Promise((_resolve, reject) => cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, "cancelled\\n"); reject(new Error("late handler rejection")); }, { once: true })) } }; },',
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
        '  activate(context) { appendFileSync(context.config.trace, "activated\\n"); return { signals: { "akuma.called": () => appendFileSync(context.config.trace, "called\\n") } }; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          hanging: { package: "./plugins/hanging.mjs", config: { trace: output } },
          working: { package: "./plugins/working.mjs", config: { trace: output } },
        },
      }),
    );

    const diagnostics: string[] = [];
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", observeUnhandled);
    const runtime = await pluginRuntime({ world: await World.at(value.root) });
    try {
      await eventually(() => trace(output).includes("activated"));
      const advance = deadlineClock(context);
      const emission = runtime.emit({ kind: "akuma.called", akumaId: "aku/example" }, (value) => diagnostics.push(value));
      await eventually(() => trace(output).includes("called"));
      advance(4_999);
      assert.deepEqual(trace(output), ["activated", "called"]);
      advance(1);
      await emission;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.deepEqual(trace(output), ["activated", "called", "cancelled"]);
      assert.equal(
        diagnostics.some((value) => value.startsWith("plugin hanging signal: timed out after 5000ms")),
        true,
      );
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  } finally {
    value.close();
  }
});

test("a timed-out handler does not share cancellation with another handler", { timeout: 5_000 }, async (context) => {
  const value = fixture();
  const cancellationKey = `keiyaku-plugin-cancellation-${Date.now()}`;
  const cancellations: Record<string, AbortSignal> = {};
  (globalThis as Record<string, unknown>)[cancellationKey] = cancellations;
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "first",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "first", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.called": (_signal, cancellation) => new Promise((resolve) => { const signals = globalThis[context.config.cancellationKey]; signals.first = cancellation; cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, `first:${signals.second.aborted}\\n`); resolve(); }, { once: true }); }) } }; },',
        "};",
      ].join("\n"),
    );
    writePlugin(
      value.root,
      "second",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "second", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.called": (_signal, cancellation) => new Promise((resolve) => { const signals = globalThis[context.config.cancellationKey]; signals.second = cancellation; cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, `second:${signals.first.aborted}\\n`); resolve(); }, { once: true }); }) } }; },',
        "};",
      ].join("\n"),
    );
    mkdirSync(join(value.root, ".keiyaku"), { recursive: true });
    writeFileSync(
      join(value.root, ".keiyaku", "settings.json"),
      JSON.stringify({
        plugins: {
          first: { package: "./plugins/first.mjs", config: { trace: output, cancellationKey } },
          second: { package: "./plugins/second.mjs", config: { trace: output, cancellationKey } },
        },
      }),
    );

    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({ world: await World.at(value.root) });
    const emission = runtime.emit({ kind: "akuma.called", akumaId: "aku/example" });
    await eventually(() => cancellations.first !== undefined && cancellations.second !== undefined);
    assert.notEqual(cancellations.first, cancellations.second);
    advance(4_999);
    assert.equal(cancellations.first?.aborted, false);
    assert.equal(cancellations.second?.aborted, false);
    assert.deepEqual(trace(output), []);
    advance(1);
    await emission;
    assert.equal(cancellations.first?.aborted, true);
    assert.equal(cancellations.second?.aborted, true);
    const observed = trace(output);
    assert.deepEqual(observed.map((row) => row.split(":")[0]).sort(), ["first", "second"]);
    // Either independent deadline may fire first; it must leave the other signal live.
    assert.deepEqual(observed.map((row) => row.split(":")[1]), ["false", "true"]);
  } finally {
    delete (globalThis as Record<string, unknown>)[cancellationKey];
    value.close();
  }
});


test("completed plugin emissions leave no timeout keeping their process alive", (context) => {
  const value = fixture();
  context.after(value.close);
  const outputPath = join(value.root, "trace.txt");
  writePlugin(
    value.root,
    "completed",
    [
      'import { appendFileSync } from "node:fs";',
      'export default { manifest: { id: "completed", apiVersion: 1 }, activate(context) { return { signals: { "akuma.called": async () => { appendFileSync(context.config.trace, "called\\n"); }, "akuma.body-ended": () => { appendFileSync(context.config.trace, "body-ended\\n"); } } }; } };',
    ].join("\n"),
  );
  mkdirSync(join(value.root, ".keiyaku"));
  writeFileSync(
    join(value.root, ".keiyaku", "settings.json"),
    JSON.stringify({
      plugins: {
        square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
        completed: { package: "./plugins/completed.mjs", config: { trace: outputPath } },
      },
    }),
  );
  const source = `
    import { pluginRuntime } from ${JSON.stringify(new URL("../src/plugin/runtime.js", import.meta.url).href)};
    import { World } from ${JSON.stringify(new URL("../src/world.js", import.meta.url).href)};
    const runtime = await pluginRuntime({ world: await World.at(${JSON.stringify(value.root)}) });
    await runtime.emit({ kind: "akuma.called", akumaId: "aku/example" });
    await runtime.emit({ kind: "akuma.body-ended", akumaId: "aku/example", bodySequence: 1, end: "exited" });
    console.log(JSON.stringify(process.getActiveResourcesInfo().filter((kind) => kind === "Timeout")));
  `;
  const output = execFileSync(
    process.execPath,
    [...(import.meta.url.endsWith(".js") ? [] : ["--import", import.meta.resolve("tsx")]), "--input-type=module", "--eval", source],
    { encoding: "utf8", timeout: 10_000 },
  );
  assert.deepEqual(JSON.parse(output), []);
  assert.deepEqual(trace(outputPath), ["called", "body-ended"]);
});
