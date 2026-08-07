import assert from "node:assert/strict";
import test from "node:test";
import { contractId, contractIdFromSegment, contractSegment } from "../src/core/facts/types.js";
import { identityCoordinate, identitySegments } from "../src/identity/coordinates.js";
import { fitIdentityStem, normalizeIdentityStem } from "../src/identity/normalize.js";

test("contract identity construction and parsing own the kei family prefix", () => {
  const id = contractIdFromSegment("example");
  assert.equal(id, "kei/example");
  assert.equal(contractSegment(id), "example");
  assert.throws(() => contractId("example"), /kei\/<contract-segment>/u);
  assert.throws(() => contractId("task/example"), /kei\/<contract-segment>/u);
  assert.throws(() => contractId("kei/one/two"), /kei\/<contract-segment>/u);
});

test("identity coordinates preserve family ownership without importing another family", () => {
  const id = identityCoordinate({ family: "task", segments: ["one", "two"] });
  assert.equal(id, "task/one/two");
  assert.deepEqual(identitySegments({ family: "task", value: id }), ["one", "two"]);
  assert.throws(() => identitySegments({ family: "kei", value: id }), /identity must use kei\//u);
  assert.throws(() => identityCoordinate({ family: "task", segments: [""] }), /nonempty segments/u);
});

test("identity normalization retains words and complete emoji graphemes", () => {
  assert.equal(
    normalizeIdentityStem({ source: "  修复 REVIEW 👩‍💻 / 🇨🇳 证据  " }),
    "修复-review-👩‍💻-🇨🇳-证据",
  );
});

test("identity normalization is idempotent and removes filename punctuation", () => {
  const sources = [
    `ＡＢＣ < > : " / \\ | ? * ... 修复`,
    "  Mixed---CASE / punctuation  ",
    "👩‍💻 / 🇨🇳 / 证据",
  ];
  for (const source of sources) {
    const normalized = normalizeIdentityStem({ source });
    assert.equal(normalizeIdentityStem({ source: normalized }), normalized);
  }
  assert.equal(normalizeIdentityStem({ source: sources[0]! }), "abc-修复");
});

test("identity fitting reserves suffix bytes without splitting a grapheme", () => {
  assert.equal(
    fitIdentityStem({ stem: "甲乙👩‍💻丙", maxBytes: 10, suffix: "abc" }),
    "甲乙-abc",
  );
});
