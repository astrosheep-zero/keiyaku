import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
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
