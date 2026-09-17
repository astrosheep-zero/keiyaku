import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const gitFixtureModuleUrl = new URL(compiledTestModules ? "./support/git.js" : "./support/git.ts", import.meta.url).href;
const externalSentinel = "external symlink target sentinel\n";

function sharedGitFixtureChildSource(): string {
  return [
    'import assert from "node:assert/strict";',
    'import { existsSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join } from "node:path";',
    'import test from "node:test";',
    `import { cloneGitRepository, gitRepositoryPath, makeGitRepository, snapshotGitRepository, withGitShim } from ${JSON.stringify(gitFixtureModuleUrl)};`,
    "",
    "const receipt = process.env.KEIYAKU_FIXTURE_RECEIPT;",
    "const external = process.env.KEIYAKU_FIXTURE_EXTERNAL;",
    "const mode = process.env.KEIYAKU_FIXTURE_MODE;",
    'const shimBody = \'exec "$KEIYAKU_REAL_GIT" "$@"\';',
    "const fixtures = {};",
    "let shims = [];",
    "",
    "function shimDirectories() {",
    "  const root = tmpdir();",
    '  return readdirSync(root)',
    '    .filter((name) => name.startsWith("keiyaku-v4-git-shim-"))',
    "    .map((name) => realpathSync(join(root, name)));",
    "}",
    "",
    "function createOwnedFixtures() {",
    "  const template = makeGitRepository();",
    '  template.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);',
    '  template.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);',
    "  const snapshot = snapshotGitRepository(template);",
    "  const clone = cloneGitRepository(template);",
    "  const raw = gitRepositoryPath();",
    '  symlinkSync(external, join(raw, "external-link"), process.platform === "win32" ? "junction" : "dir");',
    "  return { template: template.path, snapshot: snapshot.path, clone: clone.path, raw };",
    "}",
    "",
    "function exerciseScopedShims() {",
    "  const before = shimDirectories().length;",
    "  const syncShim = withGitShim(shimBody, {}, (gitPath) => gitPath);",
    '  assert.equal(existsSync(syncShim), true, "synchronous shim remains owned until terminal teardown");',
    '  assert.throws(() => withGitShim(shimBody, {}, () => { throw new Error("scoped synchronous failure"); }), /scoped synchronous failure/u);',
    "  const setupFailure = {};",
    '  Object.defineProperty(setupFailure, "KEIYAKU_SETUP_FAILURE", {',
    "    enumerable: true,",
    '    get() { throw new Error("shim setup failure"); },',
    "  });",
    '  assert.throws(() => withGitShim(shimBody, setupFailure, () => {}), /shim setup failure/u);',
    "  return async () => {",
    "    const asyncShim = await withGitShim(shimBody, {}, async (gitPath) => gitPath);",
    '    assert.equal(existsSync(asyncShim), true, "asynchronous shim remains owned until terminal teardown");',
    "    await assert.rejects(",
    '      withGitShim(shimBody, {}, async () => { throw new Error("scoped asynchronous failure"); }),',
    "      /scoped asynchronous failure/u,",
    "    );",
    "    const created = shimDirectories();",
    '    assert.equal(created.length, before + 5, "every scoped call created one owned shim directory");',
    "    return created;",
    "  };",
    "}",
    "",
    'test("shared Git fixtures are created and scoped shims settle", async () => {',
    "  Object.assign(fixtures, createOwnedFixtures());",
    "  writeFileSync(receipt, JSON.stringify({ fixtures, shims }));",
    '  if (mode === "fail") assert.fail("chosen child fixture failure");',
    "  shims = await exerciseScopedShims()();",
    "  writeFileSync(receipt, JSON.stringify({ fixtures, shims }));",
    "});",
    "",
    'test("a later test still sees the shared fixtures", () => {',
    "  for (const path of [...Object.values(fixtures), ...shims]) {",
    '    assert.equal(existsSync(path), true, "shared fixture retained across tests: " + path);',
    "  }",
    '  assert.equal(existsSync(external), true, "external symlink target survives while live");',
    "});",
    "",
  ].join("\n");
}

function runSharedGitFixtureChild(
  directory: string,
  mode: "live" | "fail",
): { status: number | null; output: string; paths: string[]; external: string; sentinel: string; temporary: string } {
  const temporary = join(directory, `${mode}-tmp`);
  const external = join(directory, `${mode}-external`);
  mkdirSync(temporary, { recursive: true });
  mkdirSync(external, { recursive: true });
  const sentinel = join(external, "sentinel.txt");
  writeFileSync(sentinel, externalSentinel);
  const receipt = join(directory, `${mode}-receipt.json`);
  const fixture = join(directory, `${mode}.test.mjs`);
  writeFileSync(fixture, sharedGitFixtureChildSource());
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    KEIYAKU_FIXTURE_RECEIPT: receipt,
    KEIYAKU_FIXTURE_EXTERNAL: external,
    KEIYAKU_FIXTURE_MODE: mode,
  };
  // An isolated child runner must not inherit Node's recursion guard.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), "--test", "--test-reporter=tap", fixture],
    { cwd: root, encoding: "utf8", env },
  );
  const output = `${result.stdout}${result.stderr}`;
  if (!existsSync(receipt)) throw new Error(`child never wrote its fixture receipt\n${output}`);
  const recorded = JSON.parse(readFileSync(receipt, "utf8")) as {
    fixtures: Record<string, string>;
    shims: string[];
  };
  return {
    status: result.status,
    output,
    paths: [...Object.values(recorded.fixtures), ...recorded.shims],
    external,
    sentinel,
    temporary,
  };
}

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

test("shared Git test fixtures remain owned across a file and retire at terminal teardown", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-fixture-lifetime-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const live = runSharedGitFixtureChild(directory, "live");
  assert.equal(live.status, 0, live.output);
  const realTemporary = realpathSync(live.temporary);
  for (const path of live.paths) {
    assert.ok(path.startsWith(realTemporary), `fixture ${path} lives under the child temp root ${realTemporary}`);
    assert.equal(existsSync(path), false, `terminal teardown removed ${path}\n${live.output}`);
  }
  assert.equal(existsSync(live.external), true, "external symlink target survives terminal teardown");
  assert.equal(readFileSync(live.sentinel, "utf8"), externalSentinel, "external target contents survive terminal teardown");
  assert.deepEqual(
    readdirSync(live.temporary).filter((name) => name.startsWith("keiyaku-v4-")),
    [],
    "no helper-owned temporary roots remain",
  );
});

test("failed child test files still retire shared Git fixtures", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-fixture-failure-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const failed = runSharedGitFixtureChild(directory, "fail");
  assert.notEqual(failed.status, 0, failed.output);
  assert.match(failed.output, /chosen child fixture failure/u);
  for (const path of failed.paths) {
    assert.equal(existsSync(path), false, `failed-file teardown removed ${path}\n${failed.output}`);
  }
  assert.equal(readFileSync(failed.sentinel, "utf8"), externalSentinel, "external target contents survive failed-file teardown");
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

test("compiled sweeps announce still-running files without killing them", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-test-runner-slow-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "tests"));
  mkdirSync(join(directory, ".test-build", "tests"), { recursive: true });
  const marker = join(directory, "slow-completed");
  writeFileSync(join(directory, "tests", "slow.test.ts"), "// source\n");
  writeFileSync(
    join(directory, ".test-build", "tests", "slow.test.js"),
    [
      "const { writeFileSync } = require('node:fs');",
      "const test = require('node:test');",
      `test('slow behaviour', async () => { await new Promise((resolve) => setTimeout(resolve, 400)); writeFileSync(${JSON.stringify(marker)}, 'completed'); });`,
    ].join("\n"),
  );
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/run-tests.mjs"), "--compiled", "--test-concurrency=1"],
    {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        KEIYAKU_TEST_STILL_RUNNING_MS: "80",
        KEIYAKU_TEST_STILL_RUNNING_INTERVAL_MS: "80",
      },
    },
  );
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  const file = ".test-build/tests/slow.test.js";
  const announcements = output.split("\n").filter((line) => line.includes(`still running: ${file} (`));
  assert.ok(announcements.length >= 2, output);
  assert.equal(
    output.split("\n").some((line) => line.includes(`PASS ${file} (`)),
    true,
    `the announced child settled with a pass\n${output}`,
  );
  assert.equal(existsSync(marker), true, "the slow child finished instead of being killed");
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
