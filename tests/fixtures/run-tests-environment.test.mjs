import assert from "node:assert/strict";
import test from "node:test";

test("repository test environment is isolated from Akuma request forwarding", () => {
  assert.equal(process.env.AKUMA_REQUESTS, undefined);
  assert.equal(process.env.KEIYAKU_TEST_SENTINEL, "sentinel bytes");
});
