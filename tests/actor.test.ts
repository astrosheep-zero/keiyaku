import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActorResolutionError,
  resolveActor,
} from "../src/core/actor.js";

const ENV = "KEIYAKU_PROJECTION_ID";

test("uses the complete Akuma projection identity from the environment", () => {
  const actor = "aku/codex/1a2b3c4d";

  assert.equal(resolveActor({ env: { [ENV]: actor } }), actor);
});

test("accepts an opaque external --actor when the projection environment is absent", () => {
  assert.equal(resolveActor({ env: {}, actor: "external:operator@example.test" }), "external:operator@example.test");
});

test("refuses a missing actor with actionable usage guidance", () => {
  assert.throws(
    () => resolveActor({ env: {} }),
    (error: unknown) => error instanceof ActorResolutionError
      && error.code === "missing-actor"
      && /KEIYAKU_PROJECTION_ID/.test(error.message)
      && /--actor <actor>/.test(error.message),
  );
});

test("rejects an invalid projection environment instead of falling back to --actor", () => {
  assert.throws(
    () => resolveActor({ env: { [ENV]: "projection/codex" }, actor: "external:operator@example.test" }),
    (error: unknown) => error instanceof ActorResolutionError
      && error.code === "invalid-projection-id"
      && /refusing --actor fallback/.test(error.message),
  );
});

test("rejects a profile-only projection environment instead of falling back to --actor", () => {
  assert.throws(
    () => resolveActor({ env: { [ENV]: "aku/codex" }, actor: "external:operator@example.test" }),
    (error: unknown) => error instanceof ActorResolutionError
      && error.code === "invalid-projection-id"
      && /complete aku\//.test(error.message)
      && /refusing --actor fallback/.test(error.message),
  );
});

test("rejects blank explicit actors", () => {
  for (const actor of ["", " \t\n"]) {
    assert.throws(
      () => resolveActor({ env: {}, actor }),
      (error: unknown) => error instanceof ActorResolutionError
        && error.code === "invalid-actor"
        && /nonblank string/.test(error.message),
    );
  }
});

test("accepts matching environment and explicit actor values", () => {
  const actor = "aku/codex/1a2b3c4d";

  assert.equal(resolveActor({ env: { [ENV]: actor }, actor }), actor);
});

test("rejects distinct environment and explicit actor bytes", () => {
  assert.throws(
    () => resolveActor({
      env: { [ENV]: "aku/codex/1a2b3c4d" },
      actor: "aku/codex/5e6f7a8b",
    }),
    (error: unknown) => error instanceof ActorResolutionError
      && error.code === "actor-conflict"
      && /exact-string identical/.test(error.message),
  );
});

test("preserves opaque external actor bytes exactly", () => {
  const actor = "external \u{1f9d1}\u{1f3fd}\u200d\u{1f4bb}";
  const resolved = resolveActor({ env: {}, actor });

  assert.equal(resolved, actor);
  assert.deepEqual(Buffer.from(resolved, "utf8"), Buffer.from(actor, "utf8"));
});
