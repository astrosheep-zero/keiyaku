import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

type TestManifestsModule = {
  TEST_MANIFESTS: {
    local: readonly string[];
    integration: readonly string[];
  };
};

const { TEST_MANIFESTS } = (await import(
  pathToFileURL(resolve("scripts/test-manifests.mjs")).href
)) as TestManifestsModule;

type TestEnvironmentModule = {
  CALLER_ENVIRONMENT_PREFIXES: readonly string[];
  CALLER_ENVIRONMENT_NAMES: readonly string[];
  TEST_ENVIRONMENT_SELECTORS: readonly string[];
  isCallerEnvironmentKey(key: string, platform?: NodeJS.Platform): boolean;
};

const {
  CALLER_ENVIRONMENT_PREFIXES,
  CALLER_ENVIRONMENT_NAMES,
  TEST_ENVIRONMENT_SELECTORS,
  isCallerEnvironmentKey,
} = (await import(pathToFileURL(resolve("scripts/test-environment.mjs")).href)) as TestEnvironmentModule;

const root = process.cwd();

test("test environment scrub recognizes caller namespaces and Windows key case", () => {
  for (const prefix of CALLER_ENVIRONMENT_PREFIXES) {
    assert.equal(isCallerEnvironmentKey(`${prefix}ANY`), true, prefix);
  }
  for (const name of CALLER_ENVIRONMENT_NAMES) assert.equal(isCallerEnvironmentKey(name), true, name);
  assert.equal(isCallerEnvironmentKey("keiyaku_actor_id", "win32"), true);
  assert.equal(isCallerEnvironmentKey("Keiyaku_Actor_Id", "win32"), true);
  assert.equal(isCallerEnvironmentKey("keiyaku_actor_id", "linux"), false);
  assert.equal(isCallerEnvironmentKey("CLAUDECODE_EXTRA"), false);
  assert.equal(isCallerEnvironmentKey("TEST_SENTINEL"), false);
  for (const selector of TEST_ENVIRONMENT_SELECTORS) {
    assert.equal(isCallerEnvironmentKey(selector), false, selector);
    assert.equal(isCallerEnvironmentKey(selector.toLowerCase(), "win32"), false, selector);
  }
});

test("test runner preserves unrelated inherited environment", () => {
  for (const sentinel of ["sentinel bytes", "wrong sentinel"]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TEST_SENTINEL: sentinel,
      KEIYAKU_SCRUBBED_SENTINEL: "must not survive",
      [TEST_ENVIRONMENT_SELECTORS[0]!]: "fixture-public-package",
    };
    // A deliberately nested runner must not inherit Node's recursion guard.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "scripts/run-tests.mjs"),
        ...(import.meta.url.endsWith(".js") ? ["--compiled"] : []),
        "--test-reporter=tap",
        "tests/fixtures/run-tests-environment.test.mjs",
      ],
      { cwd: root, encoding: "utf8", env },
    );
    assert.equal(result.status, sentinel === "sentinel bytes" ? 0 : 1, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, /repository test environment preserves selected values and scrubs reserved ones/u);
    assert.match(result.stdout + result.stderr, /# tests 1/u);
  }
});

test("focused and sweep test children own a fresh home without caller namespaces", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-runner-identity-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const parentHome = join(directory, "parent-home");
  mkdirSync(parentHome);
  writeFileSync(join(parentHome, "sentinel"), "untouched");
  const poisonedWorld = join(directory, "poisoned-world");
  mkdirSync(join(poisonedWorld, ".keiyaku"), { recursive: true });
  const poisonedHeart = join(poisonedWorld, ".keiyaku", "heart.db");
  writeFileSync(poisonedHeart, "poisoned parent heart bytes\n");
  const ambientLedger = join(directory, "ambient", "delivery.sqlite");
  mkdirSync(join(directory, "ambient"));
  const record = join(directory, "environment.json");
  const descendantRecord = join(directory, "descendant.json");
  const poisonedCallerKeys = [
    ...CALLER_ENVIRONMENT_PREFIXES.map((prefix) => `${prefix}POISONED`),
    ...CALLER_ENVIRONMENT_NAMES,
  ];
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  writeFileSync(join(directory, "tests", "environment.test.ts"), "// fixture source\n");
  writeFileSync(join(directory, ".test-build", "tests", "environment.test.js"), `
    const fs = require('node:fs');
    const path = require('node:path');
    const assert = require('node:assert/strict');
    require('node:test')('owned test environment', () => {
      const home = process.env.HOME;
      assert.equal(process.env.USERPROFILE, home);
      assert.equal(process.env.KEIYAKU_HOME, home);
      assert.ok(fs.existsSync(home));
      assert.notEqual(home, ${JSON.stringify(parentHome)});
      assert.equal(process.env.HTTPS_PROXY, "http://127.0.0.1:6152");
      assert.equal(process.env.TEST_SENTINEL, "sentinel bytes");
      assert.equal(process.env.SQUARE_DELIVERY, path.join(home, 'delivery.sqlite'));
      assert.notEqual(process.env.SQUARE_DELIVERY, ${JSON.stringify(ambientLedger)});
      for (const key of ${JSON.stringify(poisonedCallerKeys)}) {
        assert.equal(process.env[key], undefined, key);
      }
      assert.equal(process.env.KEIYAKU_ACTOR_ID, undefined);
      assert.equal(process.env.KEIYAKU_ACTOR_WORLD, undefined);
      assert.equal(process.env.PASEO_HOME, undefined);
      assert.equal(process.env.PASEO_PASSWORD, undefined);
      const child = require('node:child_process').spawnSync(process.execPath, ['-e',
        "require('node:fs').writeFileSync(process.env.TEST_DESCENDANT_RECORD, JSON.stringify({ home: process.env.HOME, actor: process.env.KEIYAKU_ACTOR_ID }))"],
        { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(fs.readFileSync(process.env.TEST_DESCENDANT_RECORD, 'utf8'), JSON.stringify({ home }));
      fs.writeFileSync(process.env.TEST_ENVIRONMENT_RECORD, JSON.stringify({ home }));
    });
  `);
  const ambient: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: parentHome,
    USERPROFILE: parentHome,
    KEIYAKU_HOME: parentHome,
    HTTPS_PROXY: "http://127.0.0.1:6152",
    SQUARE_DELIVERY: ambientLedger,
    TEST_SENTINEL: "sentinel bytes",
    TEST_ENVIRONMENT_RECORD: record,
    TEST_DESCENDANT_RECORD: descendantRecord,
    PASEO_HOME: join(directory, "live-paseo-home"),
    PASEO_PASSWORD: "live-paseo-password",
  };
  for (const key of poisonedCallerKeys) ambient[key] = `poisoned-${key}`;
  ambient.KEIYAKU_ACTOR_ID = "aku/probe/1234abcd";
  ambient.KEIYAKU_ACTOR_WORLD = poisonedWorld;
  delete ambient.NODE_TEST_CONTEXT;
  const homes: string[] = [];
  for (const sweep of [false, true]) {
    rmSync(record, { force: true });
    rmSync(descendantRecord, { force: true });
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, "scripts/run-tests.mjs"),
        "--compiled",
        ...(sweep ? ["--test-concurrency=1"] : ["tests/environment.test.ts"]),
      ],
      { cwd: directory, encoding: "utf8", env: ambient },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const observed = JSON.parse(readFileSync(record, "utf8")) as { home: string };
    assert.equal(existsSync(observed.home), false, "runner returned before fixture home cleanup");
    assert.notEqual(observed.home, parentHome);
    assert.notEqual(observed.home, process.env.HOME, "a nested runner must own its home");
    homes.push(observed.home);
    assert.deepEqual(readdirSync(parentHome), ["sentinel"]);
    assert.equal(readFileSync(join(parentHome, "sentinel"), "utf8"), "untouched");
    assert.equal(readFileSync(poisonedHeart, "utf8"), "poisoned parent heart bytes\n");
  }
  assert.notEqual(homes[0], homes[1]);
});

test("focused and sweep runners isolate Square ledgers through descendant exit and clean failures", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-runner-square-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const ambient = join(directory, "ambient");
  mkdirSync(ambient);
  writeFileSync(join(ambient, "sentinel"), "untouched");
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  writeFileSync(join(directory, "tests", "ledger.test.ts"), "// fixture source\n");
  const record = join(directory, "observed-root");
  const roots: string[] = [];
  for (const sweep of [false, true]) {
    writeFileSync(join(directory, ".test-build", "tests", "ledger.test.js"), `
      const fs = require('node:fs');
      const path = require('node:path');
      const assert = require('node:assert/strict');
      require('node:test')('isolated ledger', () => {
        const ledger = process.env.SQUARE_DELIVERY;
        const root = path.dirname(ledger);
        assert.notEqual(root, ${JSON.stringify(ambient)});
        assert.equal(ledger, path.join(root, 'delivery.sqlite'));
        assert.ok(fs.existsSync(root));
        fs.writeFileSync(${JSON.stringify(record)}, root);
        const child = require('node:child_process').spawnSync(process.execPath, ['-e',
          "require('node:fs').writeFileSync(process.env.SQUARE_DELIVERY, 'owned')"]);
        assert.equal(child.status, 0);
        assert.equal(fs.readFileSync(ledger, 'utf8'), 'owned');
        ${sweep ? "assert.fail('chosen failure');" : ""}
      });
    `);
    const result = spawnSync(process.execPath, [resolve(root, "scripts/run-tests.mjs"), "--compiled",
      ...(sweep ? ["--test-concurrency=1"] : ["tests/ledger.test.ts"])], {
      cwd: directory, encoding: "utf8", env: { ...process.env, SQUARE_DELIVERY: join(ambient, "delivery.sqlite") },
    });
    assert.equal(result.status, sweep ? 1 : 0, result.stdout + result.stderr);
    const observed = readFileSync(record, "utf8");
    roots.push(observed);
    assert.equal(existsSync(observed), false, "runner returned before ledger cleanup");
    assert.deepEqual(readdirSync(ambient), ["sentinel"]);
    assert.equal(readFileSync(join(ambient, "sentinel"), "utf8"), "untouched");
  }
  assert.notEqual(roots[0], roots[1]);
});

test("test runner suite selection is explicit and fail-closed", () => {
  assert.deepEqual([...TEST_MANIFESTS.local].sort(), TEST_MANIFESTS.local);
  assert.deepEqual([...TEST_MANIFESTS.integration].sort(), TEST_MANIFESTS.integration);
  assert.equal(
    new Set([...TEST_MANIFESTS.local, ...TEST_MANIFESTS.integration]).size,
    TEST_MANIFESTS.local.length + TEST_MANIFESTS.integration.length,
  );
  const defaultFiles = [...globSync("tests/**/*.test.ts"), ...globSync("tests/maintainability.test.js")].sort();
  assert.deepEqual([...TEST_MANIFESTS.local, ...TEST_MANIFESTS.integration].sort(), defaultFiles);

  const unknown = spawnSync(process.execPath, [resolve(root, "scripts/run-tests.mjs"), "--suite", "unknown"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown test suite/);
});

test("compiled sweeps await delayed files even when a sibling fails", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-test-runner-delayed-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  const marker = join(directory, "completed");
  writeFileSync(join(directory, "tests", "failure.test.ts"), "// source\n".repeat(100));
  writeFileSync(join(directory, "tests", "delayed.test.ts"), "// source\n");
  writeFileSync(
    join(directory, ".test-build", "tests", "failure.test.js"),
    "const test = require('node:test'); const assert = require('node:assert/strict'); test('failure', () => assert.fail('chosen failure'));",
  );
  writeFileSync(
    join(directory, ".test-build", "tests", "delayed.test.js"),
    [
      "const { writeFileSync } = require('node:fs');",
      "const test = require('node:test');",
      `test('delayed completion', async () => { await new Promise((resolve) => setTimeout(resolve, 150)); writeFileSync(${JSON.stringify(marker)}, 'done'); });`,
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/run-tests.mjs"), "--compiled", "--test-concurrency=2"],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(existsSync(marker), true, result.stdout + result.stderr);
});

test("compiled sweeps name every file and keep a per-file spec log", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-test-runner-logs-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  for (const name of ["alpha", "beta"]) {
    writeFileSync(join(directory, "tests", `${name}.test.ts`), "// source\n");
    writeFileSync(
      join(directory, ".test-build", "tests", `${name}.test.js`),
      `require('node:test')(${JSON.stringify(`${name} behaviour`)}, () => {});\n`,
    );
  }
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/run-tests.mjs"), "--compiled", "--test-concurrency=2"],
    { cwd: directory, encoding: "utf8" },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const lines = output.split("\n");
  for (const name of ["alpha", "beta"]) {
    const file = `.test-build/tests/${name}.test.js`;
    assert.equal(lines.filter((line) => line.includes(`RUNS ${file}`)).length, 1, output);
    assert.equal(
      lines.filter((line) => line.includes(`PASS ${file} (`) || line.includes(`FAIL ${file} (`)).length,
      1,
      output,
    );
  }
  const printed = /\[run-tests\] per-file logs: (.+)/u.exec(output);
  assert.ok(printed, output);
  const logDirectory = printed[1]!.trim();
  assert.equal(existsSync(logDirectory), true, output);
  const logs = readdirSync(logDirectory);
  assert.equal(logs.length, 2, output);
  for (const name of ["alpha", "beta"]) {
    const log = logs.find((entry) => entry.includes(`${name}.test.js`));
    assert.ok(log, `a spec log names ${name}\n${output}`);
    assert.match(readFileSync(join(logDirectory, log), "utf8"), new RegExp(`${name} behaviour`, "u"));
  }
  assert.match(readFileSync(resolve(root, ".gitignore"), "utf8"), /^\.test-logs\/$/mu);
});

test("focused runs stay on the single-spawn path without sweep artifacts", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-test-runner-focused-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  writeFileSync(join(directory, "tests", "focused.test.ts"), "// source\n");
  writeFileSync(
    join(directory, ".test-build", "tests", "focused.test.js"),
    "require('node:test')('focused behaviour', () => {});\n",
  );
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/run-tests.mjs"), "--compiled", "tests/focused.test.ts"],
    { cwd: directory, encoding: "utf8" },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /RUNS /u);
  assert.doesNotMatch(output, /per-file logs:/u);
  assert.equal(existsSync(join(directory, ".test-logs")), false, output);
});

test("release plan overlaps one source gate with build and awaits all owned phases", async () => {
  const { runReleasePlan } = await import(pathToFileURL(resolve(root, "scripts/test-plan.mjs")).href) as {
    runReleasePlan(run: (name: string) => Promise<number>): Promise<number>;
  };
  const pending = new Map<string, (status: number) => void>();
  const started: string[] = [];
  let cleanup = false;
  const running = runReleasePlan((name) => {
    started.push(name);
    if (cleanup) return Promise.resolve(1);
    return new Promise<number>((resolve) => pending.set(name, resolve));
  });
  let settled = false;
  void running.then(() => { settled = true; });
  const progress = () => new Promise<void>((resolve) => setImmediate(resolve));
  const finish = async (name: string) => {
    const release = pending.get(name);
    assert.ok(release, `phase not running: ${name}`);
    pending.delete(name);
    release(0);
    await progress();
  };
  try {
    await progress();
    assert.deepEqual(started, ["build", "format:check"]);
    await finish("format:check");
    assert.deepEqual([...pending.keys()], ["build", "test:architecture"]);
    await finish("build");
    assert.deepEqual([...pending.keys()], ["test:architecture", "test:compile"]);
    await finish("test:compile");
    assert.deepEqual([...pending.keys()], ["test:architecture", "test:reachability", "tests"]);
    await finish("test:reachability");
    await finish("tests");
    assert.equal(settled, false, "runtime completion must not detach a source gate");
    await finish("test:architecture");
    assert.deepEqual([...pending.keys()], ["test:maintainability"]);
    await finish("test:maintainability");
    assert.equal(await running, 0);
    assert.equal(new Set(started).size, started.length);
  } finally {
    cleanup = true;
    for (const release of pending.values()) release(1);
    await running;
  }
});

test("release plan propagates every failure without skipping independent gates", async (context) => {
  const { runReleasePlan } = await import(pathToFileURL(resolve(root, "scripts/test-plan.mjs")).href) as {
    runReleasePlan(run: (name: string) => Promise<number>): Promise<number>;
  };
  const source = ["format:check", "test:architecture", "test:maintainability"];
  const phases = ["build", "test:compile", ...source, "test:reachability", "tests"];
  for (const failed of phases) {
    const seen: string[] = [];
    assert.equal(await runReleasePlan(async (name) => {
      seen.push(name);
      return name === failed ? 7 : 0;
    }), 7, failed);
    assert.deepEqual(seen.filter((name) => source.includes(name)), source, failed);
    const expected = failed === "build" ? ["build", ...source]
      : failed === "test:compile" ? ["build", "test:compile", ...source] : phases;
    assert.deepEqual([...seen].sort(), [...expected].sort(), failed);
  }
  const diagnostics: unknown[][] = [];
  context.mock.method(console, "error", (...args: unknown[]) => diagnostics.push(args));
  assert.equal(await runReleasePlan(async (name) => {
    if (name === "test:architecture") throw new Error("broken source gate");
    return 0;
  }), 1);
  assert.match(String(diagnostics[0]?.[0]), /test:architecture/u);
});

test("explicit test selections reject missing files and unmatched patterns before executing", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-runner-missing-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = join(directory, "ran");
  const fixture = join(directory, "present.test.mjs");
  writeFileSync(fixture, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  for (const missing of ["absent.test.mjs", "absent-*.test.mjs"]) {
    const result = spawnSync(
      process.execPath,
      [resolve(root, "scripts/run-tests.mjs"), fixture, join(directory, missing)],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /Test selection contains missing file/);
    assert.equal(existsSync(marker), false);
  }
  const matched = spawnSync(
    process.execPath,
    [resolve(root, "scripts/run-tests.mjs"), join(directory, "present*.test.mjs")],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(matched.status, 0, matched.stdout + matched.stderr);
  assert.equal(readFileSync(marker, "utf8"), "ran");
});


test("native test compilation transforms syntax, maps original sources, and rejects invalid syntax", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-test-compile-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, "build", "src"), { recursive: true });
  const native = join(directory, "plugins", "paseo", "plugin");
  mkdirSync(native, { recursive: true });
  mkdirSync(join(directory, "docs"));
  mkdirSync(join(directory, "node_modules"));
  const nativeSource = "import { readFileSync } from 'node:fs';\nexport const value: string = readFileSync(new URL('./loader.txt', import.meta.url), 'utf8');\n";
  const asset = "native runtime asset\n";
  writeFileSync(join(native, "index.ts"), nativeSource);
  writeFileSync(join(native, "loader.txt"), asset);
  const otherPlugin = join(directory, "plugins", "other");
  mkdirSync(join(otherPlugin, "build"), { recursive: true });
  writeFileSync(join(otherPlugin, "index.ts"), "export const value: string = 'source';\n");
  writeFileSync(join(otherPlugin, "build", "index.js"), "export const value = 'release';\n");
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const source = join(directory, "tests", "transform.test.ts");
  writeFileSync(source, "enum Flag { Yes = 7 }\nclass Box { constructor(readonly value: number) {} }\nexport const value = new Box(Flag.Yes).value;\n");
  const compile = () => spawnSync(process.execPath, [resolve(root, "scripts/compile-tests.mjs")], {
    cwd: directory, encoding: "utf8",
  });
  const result = compile();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = join(directory, ".test-build", "tests", "transform.test.js");
  assert.equal((await import(pathToFileURL(output).href)).value, 7);
  const encoded = readFileSync(output, "utf8").match(/sourceMappingURL=data:application\/json[^,]*;base64,([^\s]+)/u)?.[1];
  assert.ok(encoded, "compiled tests must retain original-source diagnostics");
  const map = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { sources: string[] };
  // The compiler reports the canonical filesystem spelling of its working
  // directory, which is not necessarily the spelling /tmp was handed to us as.
  assert.deepEqual(map.sources.map((entry) => realpathSync(fileURLToPath(entry))), [realpathSync(source)]);
  const mirroredNative = join(directory, ".test-build", "plugins", "paseo", "plugin");
  assert.equal((await import(pathToFileURL(join(mirroredNative, "index.js")).href)).value, asset);
  assert.equal(readFileSync(join(mirroredNative, "index.ts"), "utf8"), nativeSource);
  assert.deepEqual(readFileSync(join(mirroredNative, "loader.txt")), Buffer.from(asset));
  assert.equal(readFileSync(join(native, "index.ts"), "utf8"), nativeSource);
  assert.equal(existsSync(join(native, "index.js")), false, "compilation must not emit into the authored plugin");
  const release = join(directory, ".test-build", "plugins", "other", "build", "index.js");
  assert.equal((await import(pathToFileURL(release).href)).value, "release");
  assert.equal(realpathSync(release), realpathSync(join(otherPlugin, "build", "index.js")));
  assert.equal(existsSync(join(directory, ".test-build", "plugins", "other", "index.js")), false,
    "other plugins must retain their release projection rather than compile their sources");
  writeFileSync(source, "export const broken: = ;");
  assert.notEqual(compile().status, 0, "invalid input must not silently produce executable tests");
});



test("sweep cost hints order work without selecting, mutating or dropping files", async () => {
  const { orderSweepEntries } = await import(pathToFileURL(resolve(root, "scripts/test-plan.mjs")).href) as {
    orderSweepEntries<T extends { file: string; size: number }>(entries: readonly T[]): T[];
  };
  const entries = [
    { file: "tests/cli-render.test.ts", size: 70_000 },
    { file: "tests/package-consumers.test.ts", size: 3_000 },
    { file: "new-large.test.ts", size: 1_000 },
    { file: "new-small.test.ts", size: 10 },
  ];
  const before = [...entries];
  const ordered = orderSweepEntries(entries);
  assert.deepEqual(entries, before, "planning must not mutate the caller's selection");
  assert.equal(ordered.length, entries.length);
  assert.deepEqual(new Set(ordered), new Set(entries), "every selected entry survives by identity");
  assert.ok(ordered.indexOf(entries[1]!) < ordered.indexOf(entries[0]!), "short expensive work starts first");
  assert.ok(ordered.indexOf(entries[2]!) < ordered.indexOf(entries[3]!), "unknown work keeps the size fallback");
  const windows = entries.map((entry) => ({ ...entry, file: entry.file.replaceAll("/", "\\") }));
  assert.deepEqual(orderSweepEntries(windows).map((entry) => entry.file.replaceAll("\\", "/")), ordered.map((entry) => entry.file));
  const ties = [{ file: "b", size: 1 }, { file: "a", size: 1 }];
  assert.deepEqual(orderSweepEntries(ties).map((entry) => entry.file), ["a", "b"]);
  assert.deepEqual(orderSweepEntries([]), []);
});
