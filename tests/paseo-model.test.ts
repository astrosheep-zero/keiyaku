import assert from "node:assert/strict";
import test from "node:test";
import { ProviderEventSchema } from "@getpaseo/plugin/server/provider";
import { modelConfig } from "../plugins/paseo/plugin/server/model.js";

test("mirror reports admitted model with provider label without offering model switching", () => {
  const config = modelConfig({ provider: "pi", model: "test-model" });
  ProviderEventSchema.parse({ type: "session.config", sessionId: "mirror", config });
  assert.equal(config.model, "test-model");
  assert.deepEqual(config.models, [{ id: "test-model", label: "pi / test-model", isSelectable: false }]);
  assert.deepEqual(config.settings, []);
});

test("unspecified model stays unknown rather than borrowing the mirror or provider default", () => {
  const config = modelConfig({ provider: "pi" });
  assert.equal(config.model, undefined);
  assert.deepEqual(config.models, []);
  ProviderEventSchema.parse({ type: "session.config", sessionId: "mirror", config });
});
