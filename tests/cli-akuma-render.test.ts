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

test("Akuma associations use one corner notation and a width-aware frame rule", () => {
  assert.equal(frameRule(["abc"]), "───");
  assert.equal(frameRule(["abc", "abcde"]), "─".repeat(5));
  assert.equal(associatedIdentity("aku/worker/1234abcd", "@ship"), "aku/worker/1234abcd (@ship)");
  assert.deepEqual(snapshotHeading("aku/worker/1234abcd", undefined, { kind: "associated", contractId: "kei/demo" }), [
    "aku/worker/1234abcd",
    "└─ kei/demo",
    frameRule(["aku/worker/1234abcd", "└─ kei/demo"]),
  ]);
  assert.deepEqual(snapshotHeading("aku/worker/1234abcd", "@ship", { kind: "none" }), [
    "aku/worker/1234abcd (@ship)",
    frameRule(["aku/worker/1234abcd (@ship)"]),
  ]);
});
