import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import { renderVerb } from "../src/cli/render/verbs.js";
import { acceptedReceipt } from "./support/cli-fixtures.js";
import type { RegionOverlap } from "../src/index.js";

const contract = contractId("kei/overlap-render-owner-5062");
const related = contractId("kei/overlap-render-peer-31ce");

function render(overlaps: readonly RegionOverlap[], columns = 100): string {
  return renderVerb("bind", { terms: "" }, {
    kind: "returned",
    value: acceptedReceipt("bind", {
      contractId: contract,
      target: "refs/heads/main",
      ...(overlaps.length === 0 ? {} : { overlaps }),
    }),
  }, { columns, color: false });
}

test("overlap receipt preserves repeated declarations and native Contract order", () => {
  assert.equal(render([
    { contractId: related, patterns: [
      { mine: "src/cli/parse.ts", theirs: "src/cli/parse.ts" },
      { mine: "src/cli/parse.ts", theirs: "src/cli/parse.ts" },
      { mine: "src/cli/usage.ts", theirs: "src/cli/usage.ts" },
    ] },
    { contractId: contractId("kei/overlap-render-second"), patterns: [{ mine: "tests/**", theirs: "tests/**" }] },
  ]), [
    `bind accepted  ${contract}`,
    "  target  refs/heads/main",
    "  admitted  bind",
    `  overlap  ${related} · src/cli/parse.ts · identical · src/cli/parse.ts`,
    `  overlap  ${related} · src/cli/parse.ts · identical · src/cli/parse.ts`,
    `  overlap  ${related} · src/cli/usage.ts · identical · src/cli/usage.ts`,
    "  overlap  kei/overlap-render-second · tests/** · identical · tests/**",
  ].join("\n"));
});

test("overlap receipt distinguishes known absence from unavailable observation", () => {
  assert.doesNotMatch(render([]), /\n  overlap  /u);
  const unavailable = renderVerb("amend", { contract }, { kind: "returned", value: acceptedReceipt("amend", {
    contractId: contract, overlapError: "region observation failed",
  }) }, { columns: 100, color: false });
  assert.match(unavailable, /overlap  unavailable\n  diagnostic\n  region observation failed/u);
});
