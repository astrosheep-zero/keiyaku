import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import { renderAccepted } from "../src/cli/render/contract.js";
import type { AcceptedBindResult } from "../src/cli/result.js";

const result = {
  kind: "accepted",
  verb: "bind",
  contract: contractId("kei/default-plural-wait-to-any-5062"),
  facts: [],
  settlementLags: [],
  target: "refs/heads/main",
  overlaps: [
    {
      contract: contractId("kei/attribute-live-activity-and-31ce"),
      patterns: [
        { mine: "src/library/fleet.ts", theirs: "src/library/fleet.ts" },
        { mine: "tests/cli-render.test.ts", theirs: "tests/cli-render.test.ts" },
      ],
    },
    {
      contract: contractId("kei/attribute-live-activity-and-31ce"),
      patterns: [{ mine: "src/library/fleet.ts", theirs: "src/library/fleet.ts" }],
    },
  ],
} as AcceptedBindResult;

test("overlap receipt groups a related Contract above deduplicated paths", () => {
  const text = renderAccepted(result, { columns: 80, color: false });
  assert.equal(
    text,
    [
      "✓ bound  kei/default-plural-wait-to-any-5062",
      "  target  refs/heads/main",
      "",
      "  overlap",
      "  └─ kei/attribute-live-activity-and-31ce",
      "       src/library/fleet.ts",
      "       tests/cli-render.test.ts",
    ].join("\n"),
  );
  const colored = renderAccepted(result, { columns: 80, color: true });
  assert.equal(colored.replace(/\u001b\[[0-9;]*m/gu, ""), text);
  assert.ok(colored.includes("\u001b[1mkei/attribute-live-activity-and-31ce\u001b[0m"));
});

test("overlap differing patterns retain sides and full paths at narrow widths", () => {
  const text = renderAccepted(
    {
      ...result,
      overlaps: [
        {
          contract: contractId("kei/other-ab12"),
          patterns: [{ mine: "src/cli/**", theirs: "src/cli/render/contract.ts" }],
        },
      ],
    },
    { columns: 24, color: false },
  );
  assert.ok(text.includes("  └─ kei/other-ab12\n       this   src/cli/**\n       other  src/cli/render/contract.ts"));
  assert.ok(!renderAccepted({ ...result, overlaps: [] }).includes("overlap"));
});
