import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveActor } from "../src/cli/actor.js";

const ENV = "KEIYAKU_ACTOR_ID";

test("uses opaque environment testimony without projection validation", () => {
  const actor = "projection/codex";

  assert.equal(resolveActor({ env: { [ENV]: actor } }), actor);
});

test("uses explicit nonblank actor bytes before the environment", () => {
  const actor = " external \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb} ";

  assert.equal(resolveActor({ env: { [ENV]: "different projection" }, actor }), actor);
  assert.deepEqual(Buffer.from(resolveActor({ env: { [ENV]: "different projection" }, actor })!, "utf8"), Buffer.from(actor, "utf8"));
});

test("uses environment testimony when explicit actor is absent", () => {
  assert.equal(resolveActor({ env: { [ENV]: "aku/codex" } }), "aku/codex");
});

test("returns unsigned when environment testimony is absent or blank", () => {
  assert.equal(resolveActor({ env: {} }), undefined);
  assert.equal(resolveActor({ env: { [ENV]: "" } }), undefined);
});

test("rejects a blank explicit actor instead of falling through to the environment", () => {
  assert.throws(
    () => resolveActor({ env: { [ENV]: "aku/environment" }, actor: " \t" }),
    /actor must be a nonblank string/,
  );
});
