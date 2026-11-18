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

test("overlap receipt keeps every containment pair with copyable patterns at narrow widths", () => {
  const leaves = Array.from({ length: 7 }, (_, index) => `src/cli/render/file-${index}.ts`);
  const text = render([{ contractId: related, patterns: [
    { mine: "src/cli/render/**", theirs: "src/cli/render/**" },
    { mine: "src/cli/parse.ts", theirs: "src/cli/**", relation: "mine-within-theirs" },
    ...leaves.map((mine) => ({ mine, theirs: "tests/**", relation: "mine-within-theirs" as const })),
  ] }], 20);
  const rows = text.split("\n").filter((line) => line.startsWith("  overlap  "));
  assert.equal(rows.length, 9);
  assert.equal(rows[1], `  overlap  ${related} · src/cli/parse.ts · mine within theirs · src/cli/**`);
  for (const [index, leaf] of leaves.entries())
    assert.equal(rows[index + 2], `  overlap  ${related} · ${leaf} · mine within theirs · tests/**`);
});

test("overlap receipt keeps reversed containment, native relation and undefined intersection", () => {
  const text = render([{ contractId: related, patterns: [
    { mine: "src/**", theirs: "src/cli/**", relation: "theirs-within-mine" },
    { mine: "src/*", theirs: "src/?.ts", relation: "intersect" },
    { mine: "tests/*", theirs: "tests/?.ts" },
  ] }]);
  assert.deepEqual(text.split("\n").slice(-3), [
    `  overlap  ${related} · src/** · theirs within mine · src/cli/**`,
    `  overlap  ${related} · src/* · intersect · src/?.ts`,
    `  overlap  ${related} · tests/* · intersection · tests/?.ts`,
  ]);
});

test("overlap receipt distinguishes known absence from unavailable observation", () => {
  assert.doesNotMatch(render([]), /\n  overlap  /u);
  const unavailable = renderVerb("amend", { contract }, { kind: "returned", value: acceptedReceipt("amend", {
    contractId: contract, overlapError: "region observation failed",
  }) }, { columns: 100, color: false });
  assert.match(unavailable, /overlap  unavailable\n  diagnostic\n  region observation failed/u);
});
