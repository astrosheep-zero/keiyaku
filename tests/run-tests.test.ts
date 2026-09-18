import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

type TestManifestsModule = {
  TEST_MANIFESTS: {
    local: readonly string[];
    integration: readonly string[];
  };
};

const { TEST_MANIFESTS } = (await import(
  pathToFileURL(resolve("scripts/test-manifests.mjs")).href
)) as TestManifestsModule;

const root = process.cwd();

const compiledTestModules = import.meta.url.endsWith(".js");

test("test runner removes ambient Akuma requests and preserves unrelated environment", () => {
  for (const sentinel of ["sentinel bytes", "wrong sentinel"]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AKUMA_REQUESTS: resolve(root, ".keiyaku", "ambient-requests"),
      KEIYAKU_TEST_SENTINEL: sentinel,
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
    assert.match(result.stdout + result.stderr, /repository test environment is isolated from Akuma request forwarding/u);
    assert.match(result.stdout + result.stderr, /# tests 1/u);
  }
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
  mkdirSync(join(directory, "plugins"));
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
  assert.deepEqual(map.sources, [pathToFileURL(source).href]);
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
