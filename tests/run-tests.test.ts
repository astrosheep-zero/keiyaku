import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("test runner removes ambient Akuma requests and preserves unrelated environment", () => {
  const result = spawnSync(process.execPath, [
    resolve(root, "scripts/run-tests.mjs"),
    "tests/fixtures/run-tests-environment.test.mjs",
  ], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      AKUMA_REQUESTS: resolve(root, ".keiyaku", "ambient-requests"),
      KEIYAKU_TEST_SENTINEL: "sentinel bytes",
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
