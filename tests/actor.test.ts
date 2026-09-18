import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActor } from "../src/cli/actor.js";

const ENV = "KEIYAKU_ACTOR_ID";

test("uses explicit nonblank actor bytes before the environment", () => {
  const actor = " external \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb} ";

  assert.equal(resolveActor({ env: { [ENV]: "different projection" }, actor }), actor);
  assert.deepEqual(
    Buffer.from(resolveActor({ env: { [ENV]: "different projection" }, actor })!, "utf8"),
    Buffer.from(actor, "utf8"),
  );
});

test("rejects a blank explicit actor instead of falling through to the environment", () => {
  assert.throws(
    () => resolveActor({ env: { [ENV]: "aku/environment" }, actor: " \t" }),
    /actor must be a nonblank string/,
  );
});
