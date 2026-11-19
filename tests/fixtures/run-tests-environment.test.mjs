import assert from "node:assert/strict";
import test from "node:test";
import { TEST_ENVIRONMENT_SELECTORS } from "../../scripts/test-environment.mjs";

const packageSelector = TEST_ENVIRONMENT_SELECTORS[0];

test("repository test environment preserves selected values and scrubs reserved ones", () => {
  assert.equal(process.env.TEST_SENTINEL, "sentinel bytes");
  assert.equal(process.env[packageSelector], "fixture-public-package");
  assert.equal(process.env.KEIYAKU_SCRUBBED_SENTINEL, undefined);
});
