import assert from "node:assert/strict";
import test from "node:test";
import { contractId } from "../src/core/facts/types.js";
import type { InvocationResult } from "../src/cli/result.js";
import { renderCatalogText } from "../src/cli/render/catalog.js";
import { renderText } from "../src/cli/render/text.js";

test("guidance text is the exact Markdown projection", () => {
  const guidance = "---\ncontract: kei/show\n---\n\n# Show\n";
  assert.equal(renderText({ kind: "guidance", contract: contractId("kei/show"), guidance }), guidance);
});

test("catalog text renders only the selected identity layer", () => {
  assert.equal(renderCatalogText({
    kind: "archetypes",
    rows: [{ name: "reviewer", model: "codex-5", description: "Read the complete change without truncation." }],
  }), [
    "reviewer - codex-5",
    "  Read the complete change without truncation.",
  ].join("\n"));
  assert.equal(renderCatalogText({
    kind: "akuma",
    root: "/world",
    archetype: "worker",
    rows: [{ id: "aku/worker/deadbeef" as never, life: "unborn" }],
    searched: ["/world/.keiyaku/akuma/run"],
  }), "aku/worker/deadbeef - unborn");
});

test("observation text keeps the command and view data together", () => {
  const result: InvocationResult = { kind: "observation", command: "status", contracts: [] };
  assert.equal(renderText(result), 'observation status\n{\n  "contracts": []\n}');
});
