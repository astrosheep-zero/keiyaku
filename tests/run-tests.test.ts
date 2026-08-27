import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TEST_MANIFESTS } from "../scripts/test-manifests.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("test runner removes ambient Akuma requests and preserves unrelated environment", () => {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "scripts/run-tests.mjs"), "tests/fixtures/run-tests-environment.test.mjs"],
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
