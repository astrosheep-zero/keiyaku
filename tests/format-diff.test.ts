import assert from "node:assert/strict";
import test from "node:test";
import { createTwoFilesPatch } from "diff";
import { unifiedDiff } from "../src/cli/diff.js";

test("unifiedDiff delegates to diff.createTwoFilesPatch", () => {
  const before = "one\ntwo\n";
  const after = "one\nthree\n";
  assert.equal(
    unifiedDiff(before, after),
    createTwoFilesPatch("before", "after", before, after, "", "", { context: 3 }),
  );
  assert.equal(unifiedDiff(before, before), "");
});
