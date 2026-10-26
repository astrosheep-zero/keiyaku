import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { AKUMA_REQUESTS_ENV } from "../src/akuma/provider.js";
import { emitPluginSignal } from "../src/plugin/akuma-signals.js";
import { pluginRuntime } from "../src/plugin/runtime.js";
import { outcomePluginObserver } from "../src/plugin/akuma-signals.js";
import { settings } from "../src/settings.js";
import { World } from "../src/world.js";
import { restoreEnvironmentValues } from "./support/process.js";
import { runCli } from "./support/cli-fixtures.js";

test("one outcome observation batch bounds concurrent attempts rather than multiplying timeouts", async (context) => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(value.root, "alpha", [
      'import { appendFileSync } from "node:fs";',
      'export default { manifest: { id: "alpha", apiVersion: 1 }, activate(context) {',
      '  return { signals: { "akuma.outcome-observed": (signal, cancellation) => {',
      '    appendFileSync(context.config.trace, `started:${signal.historyId}\\n`);',
      '    cancellation.addEventListener("abort", () => appendFileSync(context.config.trace, `cancelled:${signal.historyId}\\n`), { once: true });',
      '    return new Promise(() => {});',
      '  } } };',
      '} };',
    ].join("\n"));
    writeProjectPlugins(value.root, {
      square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
      alpha: { package: "./plugins/alpha.mjs", config: { trace: output } },
    });
    const world = await World.at(value.root);
    const diagnostics: string[] = [];
    const observer = outcomePluginObserver({ world, reportDiagnostic: (message) => { diagnostics.push(message); } });
    const advance = deadlineClock(context);
    const pending = observer("aku/worker/00000001", ["turn/1", "turn/2", "turn/1"]);
    await eventually(() => trace(output).filter((line) => line.startsWith("started:")).length === 2);
    advance(5_000);
    await pending;
    assert.deepEqual(trace(output).filter((line) => line.startsWith("started:")).sort(), ["started:turn/1", "started:turn/2"]);
    assert.equal(trace(output).filter((line) => line.startsWith("cancelled:")).length, 2);
    assert.equal(diagnostics.length, 2);
    await observer("aku/worker/00000001", ["turn/1", "turn/2"]);
    assert.equal(trace(output).filter((line) => line.startsWith("started:")).length, 2, "operation-local dedup survives timeout");
  } finally {
    value.close();
  }
});

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
  const ambientHome = join(root, "ambient-home");
  const plugins = join(root, "plugins");
  const restoreSquareSessionEnvironment = isolateSquareSessionEnvironment();
  const previousAmbientHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  mkdirSync(home, { recursive: true });
  mkdirSync(ambientHome, { recursive: true });
  mkdirSync(plugins, { recursive: true });
  // A runtime without explicit Settings reads the process home, which Node
  // resolves from HOME on POSIX and USERPROFILE on Windows. Point both inside
  // the fixture so the developer's real user settings never select plugins here.
  process.env.HOME = ambientHome;
  process.env.USERPROFILE = ambientHome;
  return {
    root,
    home,
    plugins,
    close: () => {
      restoreEnvironmentValues(previousAmbientHome);
      restoreSquareSessionEnvironment();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function writePlugin(root: string, name: string, source: string): void {
  writeFileSync(join(root, "plugins", `${name}.mjs`), source);
}

function writeProjectPlugins(root: string, plugins: Readonly<Record<string, unknown>>): void {
  mkdirSync(join(root, ".keiyaku"), { recursive: true });
  writeFileSync(join(root, ".keiyaku", "settings.json"), JSON.stringify({ plugins }));
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

function writeInitiatingPlugin(root: string): void {
  writePlugin(
    root,
    "alpha",
    [
      'import { appendFileSync } from "node:fs";',
      "export default {",
      '  manifest: { id: "alpha", apiVersion: 1 },',
      '  activate(context) { appendFileSync(context.config.trace, "activate\\n"); return { signals: { "akuma.initiating": (signal) => appendFileSync(context.config.trace, `signal:${signal.initiator}\\n`) } }; },',
      "};",
    ].join("\n"),
  );
}

function writeHomePlugins(home: string, output: string): void {
  writeFileSync(
    join(home, "settings.json"),
    JSON.stringify({ plugins: { alpha: { package: "./plugins/alpha.mjs", config: { trace: output } } } }),
  );
}

function callEnvironment(home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, KEIYAKU_HOME: home, SQUARE_PARTICIPANT_NAME: "tester" };
  // A caller inside an Akuma Body would forward the operation to its parent;
  // this suite asserts the local plugin boundary.
  delete environment[AKUMA_REQUESTS_ENV];
  delete environment.KEIYAKU_ACTOR_ID;
  delete environment.KEIYAKU_ACTOR_WORLD;
  return environment;
}

test("first call establishes its selected World before initiating, even if admission later refuses", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writeInitiatingPlugin(value.root);
    writeHomePlugins(value.home, output);
    const result = await runCli(["call", "ghost", "hi"], {
      cwd: value.root,
      environment: callEnvironment(value.home),
    });
    assert.equal(result.exit, 1, `call refuses the missing archetype: ${result.stdout} ${result.stderr}`);
    assert.deepEqual(trace(output), ["activate", "signal:tester"]);
    assert.equal(existsSync(join(value.root, ".keiyaku")), true);
    assert.ok(!result.stderr.includes("plugin"), `no plugin noise: ${result.stderr}`);
  } finally {
    value.close();
  }
});

test("call in an established world emits the initiating plugin signal", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writeInitiatingPlugin(value.root);
    writeHomePlugins(value.home, output);
    await World.at(value.root);
    const result = await runCli(["call", "ghost", "hi"], {
      cwd: value.root,
      environment: callEnvironment(value.home),
    });
    assert.equal(result.exit, 1, `call refuses the missing archetype: ${result.stdout} ${result.stderr}`);
    assert.deepEqual(trace(output), ["activate", "signal:tester"]);
  } finally {
    value.close();
  }
});

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
    writeProjectPlugins(value.root, {
      alpha: { package: "./plugins/alpha.mjs", config: { trace: output, label: "project-alpha" } },
      beta: { package: "./plugins/beta.mjs", config: { trace: output, label: "beta" } },
    });

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
    writeProjectPlugins(value.root, {
      broken: { package: "./plugins/broken.mjs", config: { trace: output } },
      missing: { package: "./plugins/not-found.mjs" },
      working: { package: "./plugins/working.mjs", config: { trace: output } },
    });

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

test("plugin runtime rejects a handler name outside the accepted vocabulary", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "loose",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "loose", apiVersion: 1 },',
        '  activate(context) { return { signals: { "akuma.unknown": () => appendFileSync(context.config.trace, "unknown\\n") } }; },',
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
    writeProjectPlugins(value.root, {
      loose: { package: "./plugins/loose.mjs", config: { trace: output } },
      working: { package: "./plugins/working.mjs", config: { trace: output } },
    });

    const diagnostics: string[] = [];
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (value) => diagnostics.push(value),
    });
    await runtime.emit({
      kind: "akuma.turn-outcome",
      akumaId: "aku/example",
      bodySequence: 1,
      turnSequence: 1,
      outcome: { kind: "answered", text: "done" },
    });

    await eventually(() => diagnostics.includes("plugin loose activation: plugin signal is unknown: akuma.unknown"));
    assert.deepEqual(trace(output), ["working-signal"]);
  } finally {
    value.close();
  }
});

test("the shared emission entry acquires the runtime, delivers, and isolates handler failure", async () => {
  const value = fixture();
  try {
    const output = join(value.root, "trace.txt");
    writePlugin(
      value.root,
      "throwing",
      [
        "export default {",
        '  manifest: { id: "throwing", apiVersion: 1 },',
        '  activate() { return { signals: { "akuma.initiating": () => { throw new Error("handler failure"); } } }; },',
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
        '  activate(context) { return { signals: { "akuma.initiating": (signal) => appendFileSync(context.config.trace, `signal:${signal.initiator}\\n`) } }; },',
        "};",
      ].join("\n"),
    );
    writeProjectPlugins(value.root, {
      throwing: { package: "./plugins/throwing.mjs" },
      working: { package: "./plugins/working.mjs", config: { trace: output } },
    });

    const diagnostics: string[] = [];
    await emitPluginSignal(
      { world: await World.at(value.root), reportDiagnostic: (value) => diagnostics.push(value) },
      { kind: "akuma.initiating", initiator: "tester" },
    );

    await eventually(() => trace(output).includes("signal:tester"));
    assert.deepEqual(trace(output), ["signal:tester"]);
    assert.equal(diagnostics.includes("plugin throwing signal: handler failure"), true, diagnostics.join("; "));
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
    writeProjectPlugins(value.root, { conditional: { package: "conditional-plugin", config: { trace: output } } });

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
    writeProjectPlugins(value.root, {
      case: { package: "./plugins/case.mjs" },
      duplicate: { package: "./plugins/duplicate.mjs" },
      reserved: { package: "./plugins/reserved.mjs" },
      symlink: { package: "./plugins/symlink.mjs" },
      traversal: { package: "./plugins/traversal.mjs" },
      valid: { package: "./plugins/valid.mjs", config: { trace: output } },
    });

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

test("a healthy plugin is emitted to while another activation hangs", { timeout: 5_000 }, async (context) => {
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
        '  activate(context, cancellation) { appendFileSync(context.config.trace, "activation-started\\n"); return new Promise((resolve) => cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, "activation-aborted\\n"); resolve({ signals: { "akuma.born": () => appendFileSync(context.config.trace, "late-called\\n") } }); }, { once: true })); },',
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
        '  activate(context) { appendFileSync(context.config.trace, "activated\\n"); return { signals: { "akuma.born": () => appendFileSync(context.config.trace, "called\\n") } }; },',
        "};",
      ].join("\n"),
    );
    writeProjectPlugins(value.root, {
      square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
      hanging: { package: "./plugins/hanging.mjs", config: { trace: output } },
      working: { package: "./plugins/working.mjs", config: { trace: output } },
    });

    const diagnostics: string[] = [];
    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (value) => diagnostics.push(value),
    });
    // Emitted immediately after runtime acquisition, while the hanging activation
    // is still in flight: the ready plugin's own activation is the only thing its
    // handler waits for, so no clock advance or staging delay is needed.
    const emission = runtime.emit({ kind: "akuma.born", akumaId: "aku/example", bodySequence: 1, origin: { kind: "direct" }, caller: { kind: "unknown" } }, (value) => diagnostics.push(value));
    await eventually(() => trace(output).includes("activation-started") && trace(output).includes("called"));
    assert.deepEqual(trace(output), ["activation-started", "activated", "called"]);
    advance(5_000);
    await emission;
    // The hung activation is bounded and diagnosed, and its late handler set
    // never replays the emission it missed.
    assert.deepEqual(trace(output), ["activation-started", "activated", "called", "activation-aborted"]);
    assert.equal(diagnostics.includes("plugin hanging activation: timed out after 5000ms"), true, diagnostics.join("; "));
    assert.equal(diagnostics.includes("plugin hanging signal: timed out after 5000ms"), true, diagnostics.join("; "));
  } finally {
    value.close();
  }
});

test("a plugin activated after the signal deadline cannot replay the emission", { timeout: 5_000 }, async (context) => {
  const value = fixture();
  const gateKey = `keiyaku-plugin-gate-${Date.now()}`;
  let openGate!: () => void;
  (globalThis as Record<string, unknown>)[gateKey] = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  try {
    const output = join(value.root, "trace.txt");
    // A gated import holds the first activation attempt, which in turn holds the
    // ordered start of the second plugin until that attempt bound.
    writePlugin(
      value.root,
      "blocked",
      [
        'import { appendFileSync } from "node:fs";',
        `await globalThis[${JSON.stringify(gateKey)}];`,
        "export default {",
        '  manifest: { id: "blocked", apiVersion: 1 },',
        '  activate(context) { appendFileSync(context.config.trace, "blocked-activated\\n"); return {}; },',
        "};",
      ].join("\n"),
    );
    writePlugin(
      value.root,
      "ready",
      [
        'import { appendFileSync } from "node:fs";',
        "export default {",
        '  manifest: { id: "ready", apiVersion: 1 },',
        '  activate(context) { appendFileSync(context.config.trace, "ready-activated\\n"); return { signals: { "akuma.born": () => appendFileSync(context.config.trace, "ready-signal\\n") } }; },',
        "};",
      ].join("\n"),
    );
    writeProjectPlugins(value.root, {
      square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
      blocked: { package: "./plugins/blocked.mjs", config: { trace: output } },
      ready: { package: "./plugins/ready.mjs", config: { trace: output } },
    });

    const diagnostics: string[] = [];
    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({
      world: await World.at(value.root),
      reportDiagnostic: (value) => diagnostics.push(value),
    });
    const emission = runtime.emit({ kind: "akuma.born", akumaId: "aku/example", bodySequence: 1, origin: { kind: "direct" }, caller: { kind: "unknown" } }, (value) => diagnostics.push(value));
    advance(5_000);
    await eventually(() => trace(output).includes("ready-activated"));
    await emission;
    assert.deepEqual(trace(output), ["ready-activated"], "the late activation never receives the emission");
    assert.equal(diagnostics.includes("plugin blocked activation: timed out after 5000ms"), true, diagnostics.join("; "));
    assert.equal(diagnostics.some((value) => value.startsWith("plugin ready signal:")), true, diagnostics.join("; "));
  } finally {
    openGate();
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
        '  activate(context) { return { signals: { "akuma.born": (_signal, cancellation) => new Promise((_resolve, reject) => cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, "cancelled\\n"); reject(new Error("late handler rejection")); }, { once: true })) } }; },',
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
        '  activate(context) { appendFileSync(context.config.trace, "activated\\n"); return { signals: { "akuma.born": () => appendFileSync(context.config.trace, "called\\n") } }; },',
        "};",
      ].join("\n"),
    );
    writeProjectPlugins(value.root, {
      hanging: { package: "./plugins/hanging.mjs", config: { trace: output } },
      working: { package: "./plugins/working.mjs", config: { trace: output } },
    });

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
      const emission = runtime.emit({ kind: "akuma.born", akumaId: "aku/example", bodySequence: 1, origin: { kind: "direct" }, caller: { kind: "unknown" } }, (value) => diagnostics.push(value));
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
        '  activate(context) { return { signals: { "akuma.born": (_signal, cancellation) => new Promise((resolve) => { const signals = globalThis[context.config.cancellationKey]; signals.first = cancellation; cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, `first:${signals.second.aborted}\\n`); resolve(); }, { once: true }); }) } }; },',
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
        '  activate(context) { return { signals: { "akuma.born": (_signal, cancellation) => new Promise((resolve) => { const signals = globalThis[context.config.cancellationKey]; signals.second = cancellation; cancellation.addEventListener("abort", () => { appendFileSync(context.config.trace, `second:${signals.first.aborted}\\n`); resolve(); }, { once: true }); }) } }; },',
        "};",
      ].join("\n"),
    );
    writeProjectPlugins(value.root, {
      first: { package: "./plugins/first.mjs", config: { trace: output, cancellationKey } },
      second: { package: "./plugins/second.mjs", config: { trace: output, cancellationKey } },
    });

    const advance = deadlineClock(context);
    const runtime = await pluginRuntime({ world: await World.at(value.root) });
    const emission = runtime.emit({ kind: "akuma.born", akumaId: "aku/example", bodySequence: 1, origin: { kind: "direct" }, caller: { kind: "unknown" } });
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


test("separately installed Paseo resolves from the World and absent daemon is one diagnostic", async (context) => {
  const value = fixture();
  context.after(value.close);
  const previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = value.home;
  context.after(() => { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; });
  const scope = join(value.root, "node_modules", "@astrosheep");
  mkdirSync(scope, { recursive: true });
  symlinkSync(
    resolve(import.meta.dirname, import.meta.url.endsWith(".js") ? "../.." : "..", "plugins/paseo/forwarder"),
    join(scope, "keiyaku-plugin-paseo"),
    "dir",
  );
  writeProjectPlugins(value.root, { paseo: { package: "@astrosheep/keiyaku-plugin-paseo" } });
  const diagnostics: string[] = [];
  const runtime = await pluginRuntime({
    world: await World.at(value.root), settings: await settings({ root: value.root, home: value.home }),
    reportDiagnostic: (message) => { diagnostics.push(message); },
  });
  const start = performance.now();
  await runtime.emit({ kind: "akuma.turn-started", akumaId: "aku/test/1", turnSequence: 1 });
  assert.ok(performance.now() - start < 4000, "missing instance fails quickly");
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /plugin paseo signal:.*Daemon is not running/u);
  assert.doesNotMatch(diagnostics[0] ?? "", /Cannot find|activation/u);
});

test("missing selected Paseo does not fall back to the core installation or block another observer", async (context) => {
  const value = fixture();
  context.after(value.close);
  const output = join(value.root, "trace.txt");
  writeInitiatingPlugin(value.root);
  writeProjectPlugins(value.root, {
    alpha: { package: "./plugins/alpha.mjs", config: { trace: output } },
    paseo: { package: "@astrosheep/keiyaku-plugin-paseo" },
  });
  const diagnostics: string[] = [];
  const runtime = await pluginRuntime({
    world: await World.at(value.root), settings: await settings({ root: value.root, home: value.home }),
    reportDiagnostic: (message) => { diagnostics.push(message); },
  });
  await runtime.emit({ kind: "akuma.initiating", initiator: "tester" });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0] ?? "", /plugin paseo import:.*@astrosheep\/keiyaku-plugin-paseo/u);
  assert.deepEqual(trace(output), ["activate", "signal:tester"]);
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
      'export default { manifest: { id: "completed", apiVersion: 1 }, activate(context) { return { signals: { "akuma.born": async () => { appendFileSync(context.config.trace, "called\\n"); }, "akuma.body-ended": () => { appendFileSync(context.config.trace, "body-ended\\n"); } } }; } };',
    ].join("\n"),
  );
  writeProjectPlugins(value.root, {
    square: { package: "@astrosheep/keiyaku-plugin-square", enabled: false },
    completed: { package: "./plugins/completed.mjs", config: { trace: outputPath } },
  });
  const source = `
    import { pluginRuntime } from ${JSON.stringify(new URL("../src/plugin/runtime.js", import.meta.url).href)};
    import { World } from ${JSON.stringify(new URL("../src/world.js", import.meta.url).href)};
    const runtime = await pluginRuntime({ world: await World.at(${JSON.stringify(value.root)}) });
    await runtime.emit({ kind: "akuma.born", akumaId: "aku/example", bodySequence: 1, origin: { kind: "direct" }, caller: { kind: "unknown" } });
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
