import assert from "node:assert/strict";
import test from "node:test";

test("repository test environment preserves inherited values", () => {
  assert.equal(process.env.KEIYAKU_TEST_SENTINEL, "sentinel bytes");
});
