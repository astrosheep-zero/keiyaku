import assert from "node:assert/strict";
import test from "node:test";
import { contractId, contractIdFromSegment, contractSegment } from "../src/core/facts/types.js";
import { identityCoordinate, identitySegments } from "../src/identity/coordinates.js";
import { mintIdentitySegment } from "../src/identity/mint.js";
import { fitIdentityStem, fitIdentityStemWords, normalizeIdentityStem } from "../src/identity/normalize.js";

test("contract identity construction and parsing own the kei family prefix", () => {
  const id = contractIdFromSegment("example");
  assert.equal(id, "kei/example");
  assert.equal(contractSegment(id), "example");
  assert.throws(() => contractId("example"), /kei\/<contract-segment>/u);
  assert.throws(() => contractId("task/example"), /kei\/<contract-segment>/u);
  assert.throws(() => contractId("kei/one/two"), /kei\/<contract-segment>/u);
});

test("contract identity parsing accepts existing long persisted segments", () => {
  const segment = "legacy-contract-name-that-predates-the-current-generated-id-budget-0123456789";
  const id = contractIdFromSegment(segment);
  assert.equal(contractId(id), id);
  assert.equal(contractSegment(id), segment);
});

test("identity coordinates preserve family ownership without importing another family", () => {
  const id = identityCoordinate({ family: "task", segments: ["one", "two"] });
  assert.equal(id, "task/one/two");
  assert.deepEqual(identitySegments({ family: "task", value: id }), ["one", "two"]);
  assert.throws(() => identitySegments({ family: "kei", value: id }), /identity must use kei\//u);
  assert.throws(() => identityCoordinate({ family: "task", segments: [""] }), /nonempty segments/u);
});

test("identity coordinates reject dot path segments", () => {
  for (const segment of [".", ".."]) {
    assert.throws(
      () => identityCoordinate({ family: "task", segments: [segment] }),
      /nonempty segments/u,
    );
    assert.throws(
      () => identitySegments({ family: "task", value: `task/${segment}` }),
      /invalid segment/u,
    );
  }
});

test("contract identities reject dot path segments", () => {
  for (const segment of [".", ".."]) {
    assert.throws(() => contractIdFromSegment(segment), /nonempty segments/u);
    assert.throws(() => contractId(`kei/${segment}`), /kei\/<contract-segment>/u);
  }
});

test("identity normalization retains words and complete emoji graphemes", () => {
  assert.equal(normalizeIdentityStem({ source: "  修复 REVIEW 👩‍💻 / 🇨🇳 证据  " }), "修复-review-👩‍💻-🇨🇳-证据");
});

test("identity normalization is idempotent and removes filename punctuation", () => {
  const sources = [`ＡＢＣ < > : " / \\ | ? * ... 修复`, "  Mixed---CASE / punctuation  ", "👩‍💻 / 🇨🇳 / 证据"];
  for (const source of sources) {
    const normalized = normalizeIdentityStem({ source });
    assert.equal(normalizeIdentityStem({ source: normalized }), normalized);
  }
  assert.equal(normalizeIdentityStem({ source: sources[0]! }), "abc-修复");
});

test("identity fitting reserves suffix bytes without splitting a grapheme", () => {
  assert.equal(fitIdentityStem({ stem: "甲乙👩‍💻丙", maxBytes: 10, suffix: "abc" }), "甲乙-abc");
});

test("word fitting keeps whole words within the code point budget", () => {
  assert.equal(
    fitIdentityStemWords({ stem: "one-two-three-four-five-six-seven-eight-nine-ten", maxCodePoints: 32 }),
    "one-two-three-four-five-six",
  );
  assert.equal(fitIdentityStemWords({ stem: "single-word", maxCodePoints: 32 }), "single-word");
  assert.equal(fitIdentityStemWords({ stem: "👩‍💻-修复", maxCodePoints: 32 }), "👩‍💻-修复");
});

test("word fitting truncates an oversize head grapheme-safely and never yields empty", () => {
  const fitted = fitIdentityStemWords({ stem: "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz", maxCodePoints: 32 });
  assert.equal(fitted, "abcdefghijklmnopqrstuvwxyzabcdef");
  assert.equal([...fitted].length, 32);
  assert.throws(() => fitIdentityStemWords({ stem: "甲乙", maxCodePoints: 0 }), /positive safe integer/u);
});

test("identity minting redraws a fresh suffix after a collision and stays bounded", async () => {
  const attempts: string[] = [];
  const suffixes = ["0000", "0001", "0002"];
  const accepted = await mintIdentitySegment({
    stem: "example",
    attempts: 3,
    drawSuffix: () => suffixes[attempts.length]!,
    attempt: async (segment) => {
      attempts.push(segment);
      return { segment, collision: segment !== "example-0002" };
    },
    collision: (value) => value.collision,
  });
  assert.deepEqual(attempts, ["example-0000", "example-0001", "example-0002"]);
  assert.equal(accepted.segment, "example-0002");

  const exhausted: string[] = [];
  const refused = await mintIdentitySegment({
    stem: "example",
    attempts: 2,
    drawSuffix: () => "ffff",
    attempt: async (segment) => {
      exhausted.push(segment);
      return { segment, collision: true };
    },
    collision: (value) => value.collision,
  });
  assert.deepEqual(exhausted, ["example-ffff", "example-ffff"]);
  assert.equal(refused.segment, "example-ffff");
});

test("identity minting rejects a suffix outside four lowercase hex digits", async () => {
  await assert.rejects(
    () =>
      mintIdentitySegment({
        stem: "example",
        attempts: 1,
        drawSuffix: () => "ABCDE",
        attempt: async (segment) => segment,
        collision: () => false,
      }),
    /four lowercase hexadecimal digits/u,
  );
});
