import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import { renderAccepted } from "../src/cli/render/contract.js";
import type { AcceptedBindResult } from "../src/cli/result.js";

const result = {
  kind: "accepted",
  verb: "bind",
  contract: contractId("kei/overlap-render-owner-5062"),
  facts: [],
  settlementLags: [],
  target: "refs/heads/main",
  overlaps: [],
} as AcceptedBindResult;

function render(overlaps: NonNullable<AcceptedBindResult["overlaps"]>, columns = 100): string {
  return renderAccepted({ ...result, overlaps }, { columns, color: false });
}

const related = contractId("kei/overlap-render-peer-31ce");

test("overlap receipt renders identical declarations once and separates Contracts", () => {
  assert.equal(
    render([
      {
        contract: related,
        patterns: [
          { mine: "src/cli/parse.ts", theirs: "src/cli/parse.ts", relation: "same" },
          { mine: "src/cli/parse.ts", theirs: "src/cli/parse.ts", relation: "same" },
          { mine: "src/cli/usage.ts", theirs: "src/cli/usage.ts", relation: "same" },
        ],
      },
      {
        contract: contractId("kei/overlap-render-second"),
        patterns: [{ mine: "tests/**", theirs: "tests/**", relation: "same" }],
      },
    ]),
    [
      "✓ bound  kei/overlap-render-owner-5062",
      "  target  refs/heads/main",
      "",
      "  overlap  kei/overlap-render-peer-31ce",
      "    ≡  src/cli/parse.ts",
      "    ≡  src/cli/usage.ts",
      "",
      "  overlap  kei/overlap-render-second",
      "    ≡  tests/**",
    ].join("\n"),
  );
});

test("overlap receipt renders containment trees with aligned leaves and truncation", () => {
  const leaves = Array.from({ length: 7 }, (_, index) => `src/cli/render/file-${index}.ts`);
  const text = render([
    {
      contract: related,
      patterns: [
        { mine: "src/cli/render/**", theirs: "src/cli/render/**", relation: "same" },
        { mine: "src/cli/parse.ts", theirs: "src/cli/**", relation: "mine-within-theirs" },
        ...leaves.map((mine) => ({ mine, theirs: "tests/**", relation: "mine-within-theirs" as const })),
      ],
    },
  ]);
  assert.equal(
    text,
    [
      "✓ bound  kei/overlap-render-owner-5062",
      "  target  refs/heads/main",
      "",
      "  overlap  kei/overlap-render-peer-31ce",
      "    ≡  src/cli/render/**",
      "    src/cli/parse.ts  ⊂  src/cli/**",
      "    src/cli/render/file-0.ts  ⊂  tests/**",
      "    src/cli/render/file-1.ts  ⊂  tests/**",
      "    src/cli/render/file-2.ts  ⊂  tests/**",
      "    src/cli/render/file-3.ts  ⊂  tests/**",
      "    src/cli/render/file-4.ts  ⊂  tests/**",
      "    src/cli/render/file-5.ts  ⊂  tests/**",
      "    … (1 more)  ⊂  tests/**",
    ].join("\n"),
  );
});

test("overlap receipt renders reversed containment and partial intersection", () => {
  const text = render([
    {
      contract: related,
      patterns: [
        { mine: "src/**", theirs: "src/cli/**", relation: "theirs-within-mine" },
        { mine: "src/*", theirs: "src/?.ts", relation: "intersect" },
      ],
    },
  ]);
  assert.match(text, /    src\/cli\/\*\*  ⊂  src\/\*\*[\s\S]*    ∩  src\/\* · src\/\?\.ts/u);
  assert.doesNotMatch(text, /this|other/u);
});

test("overlap receipt omits the block when there are no overlaps", () => {
  assert.doesNotMatch(render([]), /\n  overlap  /u);
});
