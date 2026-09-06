import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/run-tests.mjs"),
      ...(import.meta.url.endsWith(".js") ? ["--compiled"] : []),
      "tests/fixtures/run-tests-environment.test.mjs",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        AKUMA_REQUESTS: resolve(root, ".keiyaku", "ambient-requests"),
        KEIYAKU_TEST_SENTINEL: "sentinel bytes",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const failing = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/run-tests.mjs"),
      ...(import.meta.url.endsWith(".js") ? ["--compiled"] : []),
      "--test-reporter=spec",
      "tests/fixtures/run-tests-environment.test.mjs",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, KEIYAKU_TEST_SENTINEL: "wrong bytes" },
    },
  );
  assert.equal(failing.status, 1, failing.stderr || failing.stdout);
  assert.match(failing.stdout + failing.stderr, /wrong bytes/);
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
