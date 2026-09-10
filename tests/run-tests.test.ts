import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type TestManifestsModule = {
  TEST_MANIFESTS: {
    local: readonly string[];
    integration: readonly string[];
  };
};

const { TEST_MANIFESTS } = (await import(new URL("../scripts/test-manifests.mjs", import.meta.url).href)) as TestManifestsModule;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("test runner removes ambient Akuma requests and actually executes its child tests", () => {
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
      [resolve(root, "scripts/run-tests.mjs"), "--test-reporter=tap", "tests/fixtures/run-tests-environment.test.mjs"],
      { cwd: root, encoding: "utf8", env },
    );
    assert.equal(result.status, sentinel === "sentinel bytes" ? 0 : 1, result.stderr || result.stdout);
    assert.match(result.stdout, /repository test environment is isolated from Akuma request forwarding/u);
    assert.match(result.stdout, /# tests 1/u);
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
