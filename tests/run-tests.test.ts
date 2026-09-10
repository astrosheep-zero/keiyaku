import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("compiled sweeps schedule large files first without losing isolation or failures", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-test-runner-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  const order = join(directory, "order");
  for (const name of ["a", "z"]) {
    writeFileSync(join(directory, "tests", `${name}.test.ts`), "// source\n".repeat(name === "z" ? 100 : 1));
    writeFileSync(
      join(directory, ".test-build", "tests", `${name}.test.js`),
      [
        `require('node:fs').appendFileSync(${JSON.stringify(order)}, '${name}');`,
        "require('node:test')('isolated fixture', () => {",
        "  require('node:assert/strict').equal(process.env.AKUMA_REQUESTS, undefined);",
        "  require('node:assert/strict').equal(process.env.KEIYAKU_TEST_SENTINEL, 'sentinel');",
        "  process.env.KEIYAKU_TEST_SENTINEL = 'must not leak to the next file';",
        "});",
      ].join("\n"),
    );
  }
  const run = (sentinel: string) =>
    spawnSync(process.execPath, [resolve(root, "scripts/run-tests.mjs"), "--compiled", "--test-concurrency=1"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, AKUMA_REQUESTS: "ambient", KEIYAKU_TEST_SENTINEL: sentinel },
    });
  const passed = run("sentinel");
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(readFileSync(order, "utf8"), "za");
  const failed = run("wrong bytes");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /wrong bytes/u);
  assert.equal(readFileSync(order, "utf8"), "zaza");
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

test("test entry reruns checks and retires bytecode after success and failure", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-entry-lifecycle-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const phases = ["test:architecture", "test:local", "test:typecheck"];
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: Object.fromEntries(phases.map((phase) => [phase, "node phase.mjs"])),
    }),
  );
  writeFileSync(
    join(directory, "phase.mjs"),
    [
      'import { appendFileSync, existsSync } from "node:fs";',
      'import assert from "node:assert/strict";',
      "const phase = process.env.npm_lifecycle_event, cache = process.env.NODE_COMPILE_CACHE;",
      "assert.ok(cache && existsSync(cache));",
      'appendFileSync("phases.jsonl", JSON.stringify({ phase, cache }) + "\\n");',
      "if (phase === process.env.FAIL_PHASE) process.exitCode = 7;",
    ].join("\n"),
  );
  const caches: string[] = [];
  for (const fail of [false, true]) {
    writeFileSync(join(directory, "phases.jsonl"), "");
    const result = spawnSync(process.execPath, [resolve(root, "scripts/test-entry.mjs"), "--dev"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_V8_COVERAGE: undefined,
        NODE_DISABLE_COMPILE_CACHE: undefined,
        NODE_COMPILE_CACHE: undefined,
        FAIL_PHASE: fail ? "test:typecheck" : "",
      },
    });
    assert.equal(result.status, fail ? 7 : 0, result.stdout + result.stderr);
    const records = readFileSync(join(directory, "phases.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; cache: string });
    assert.deepEqual(records.map(({ phase }) => phase).sort(), fail ? [phases[0], phases[2]] : phases);
    assert.equal(new Set(records.map(({ cache }) => cache)).size, 1);
    caches.push(records[0]!.cache);
    assert.equal(existsSync(records[0]!.cache), false);
  }
  assert.notEqual(caches[0], caches[1]);
});

test("release test entry completes build before parallel preparation and stops after build failure", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-release-entry-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const preparation = ["format:check", "test:architecture", "test:maintainability", "test:compile"];
  const phases = ["build", ...preparation, "test:reachability"];
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", scripts: Object.fromEntries(phases.map((phase) => [phase, "node phase.mjs"])) }),
  );
  mkdirSync(join(directory, "scripts"));
  writeFileSync(
    join(directory, "phase.mjs"),
    [
      'import { appendFileSync } from "node:fs";',
      "const phase = process.env.npm_lifecycle_event;",
      'appendFileSync("phases.jsonl", phase + "\\n");',
      'if (phase === process.env.FAIL_PHASE) process.exitCode = 7;',
    ].join("\n"),
  );
  writeFileSync(join(directory, "scripts", "run-tests.mjs"), 'import { appendFileSync } from "node:fs"; appendFileSync("phases.jsonl", "tests\\n");');

  for (const fail of ["", "build"]) {
    writeFileSync(join(directory, "phases.jsonl"), "");
    const result = spawnSync(process.execPath, [resolve(root, "scripts/test-entry.mjs"), "--release"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", FAIL_PHASE: fail },
    });
    assert.equal(result.status, fail === "build" ? 7 : 0, result.stdout + result.stderr);
    const records = readFileSync(join(directory, "phases.jsonl"), "utf8").trim().split("\n");
    assert.equal(records[0], "build");
    if (fail === "build") {
      assert.deepEqual(records, ["build"]);
    } else {
      assert.deepEqual(records.slice(1, 5).sort(), [...preparation].sort());
      assert.deepEqual(records.slice(5).sort(), ["test:reachability", "tests"]);
    }
  }
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
