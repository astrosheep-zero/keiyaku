import assert from "node:assert/strict";
import test from "node:test";
import { akumaMark } from "../src/cli/render/kanshi-akuma.js";
import { associatedIdentity, snapshotHeading } from "../src/cli/render/akuma-activity.js";

test("Akuma presentation uses the settled six-mark vocabulary", () => {
  assert.equal(akumaMark("killed"), "×");
  assert.equal(akumaMark("running"), "●");
  assert.equal(akumaMark("asleep"), "○");
  assert.equal(akumaMark("stranded"), "!");
});

test("Akuma associations use one arrow notation without rulers", () => {
  assert.equal(associatedIdentity("aku/worker/1234abcd", "@ship"), "aku/worker/1234abcd (@ship)");
  assert.deepEqual(snapshotHeading("aku/worker/1234abcd", undefined, { kind: "associated", contractId: "kei/demo" }), [
    "aku/worker/1234abcd",
    "-> kei/demo",
  ]);
});
