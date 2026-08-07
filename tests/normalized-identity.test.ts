import assert from "node:assert/strict";
import test from "node:test";
import { fitIdentityStem, normalizeIdentityStem } from "../src/identity/normalize.js";

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
