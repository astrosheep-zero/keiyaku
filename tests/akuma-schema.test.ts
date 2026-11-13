import assert from "node:assert/strict";
import test from "node:test";
import { canonicalDocument } from "../src/akuma/schema.js";
import { KeiyakuError } from "../src/errors.js";

test("JSON Schema admission freezes an independent canonical document", () => {
  const document = { required: ["ok"], type: "object", properties: { ok: { type: "boolean" } } };
  const canonical = canonicalDocument(document);
  const shuffled = canonicalDocument({ properties: document.properties, type: "object", required: ["ok"] });
  assert.deepEqual(canonical, shuffled);
  assert.ok(Object.isFrozen(canonical.json));
  assert.ok(Object.isFrozen(canonical.json.properties));
  document.properties.ok.type = "string";
  assert.deepEqual(canonical.json.properties, { ok: { type: "boolean" } });
});

test("JSON Schema admission bounds encoded bytes before work", () => {
  const invalidInput = (error: unknown) => error instanceof KeiyakuError && error.category === "invalid-input";
  assert.throws(() => canonicalDocument({ type: "object", description: "x".repeat(70_000) }), invalidInput);
  assert.throws(() => canonicalDocument({ type: "object", description: "é".repeat(40_000) }), invalidInput);
});
