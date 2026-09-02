import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type TestManifestsModule = {
  TEST_MANIFESTS: {
    pure: readonly string[];
    isolated: readonly string[];
    local: readonly string[];
    integration: readonly string[];
  };
};

const { TEST_MANIFESTS } = (await import(
  new URL("../scripts/test-manifests.mjs", import.meta.url).href,
)) as TestManifestsModule;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("test runner removes ambient Akuma requests and preserves unrelated environment", () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/run-tests.mjs"),
      "--no-test-isolation",
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
});

test("test runner suite selection is explicit and fail-closed", () => {
  for (const files of Object.values(TEST_MANIFESTS)) assert.deepEqual([...files].sort(), files);

  const complete = [...TEST_MANIFESTS.local, ...TEST_MANIFESTS.integration];
  assert.equal(new Set(complete).size, complete.length);

  const scheduled = [...TEST_MANIFESTS.pure, ...TEST_MANIFESTS.isolated];
  assert.equal(new Set(scheduled).size, scheduled.length);
  assert.ok(TEST_MANIFESTS.pure.every((file) => TEST_MANIFESTS.local.includes(file)));

  const defaultFiles = [...globSync("tests/**/*.test.ts"), ...globSync("tests/maintainability.test.js")].sort();
  assert.deepEqual(complete.sort(), defaultFiles);
  assert.deepEqual(scheduled.sort(), defaultFiles);

  const unknown = spawnSync(process.execPath, [resolve(root, "scripts/run-tests.mjs"), "--suite", "unknown"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /Unknown test suite/);
});
