import assert from "node:assert/strict";
import test from "node:test";
import { akumaMark } from "../src/cli/render/kanshi-akuma.js";
import { associatedIdentity, frameRule, snapshotHeading } from "../src/cli/render/akuma-activity.js";

test("Akuma presentation uses the settled six-mark vocabulary", () => {
  assert.equal(akumaMark("killed"), "×");
  assert.equal(akumaMark("running"), "●");
  assert.equal(akumaMark("asleep"), "○");
  assert.equal(akumaMark("stranded"), "!");
});
