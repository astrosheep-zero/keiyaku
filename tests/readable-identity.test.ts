import assert from "node:assert/strict";
import test from "node:test";
import { fitReadableStem, normalizeReadableStem } from "../src/identity/readable.js";

test("readable stems preserve words and complete emoji graphemes", () => {
  assert.equal(
    normalizeReadableStem({ source: "  修复 REVIEW 👩‍💻 / 证据  " }),
    "修复-review-👩‍💻-证据",
  );
});

test("readable fitting reserves suffix bytes without splitting a grapheme", () => {
  assert.equal(
    fitReadableStem({ stem: "甲乙👩‍💻丙", maxBytes: 10, suffix: "abc" }),
    "甲乙-abc",
  );
});
