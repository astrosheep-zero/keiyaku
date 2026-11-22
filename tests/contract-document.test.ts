import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeContractDocument } from "../src/document/decode.js";
import { KeiyakuError } from "../src/errors.js";

function withCriteria(criteria: string): string {
  return contractMarkdown("Day One", {
    Context: "facts.",
    Objective: "ship.",
    Design: "adapter.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: [criteria].join("\n"),
  });
}

test("contract Markdown reports the first structural failure and the next one after repair", () => {
  const source = [
    "# Broken",
    "",
    "## Context",
    "facts.",
    "",
    "## Objective",
    "ship.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "### Region heading",
    "",
    "## Criteria",
    "- flat criterion",
    "",
    "## Verification",
    "prose instead of a fence",
    "",
    "## Gates",
    "reserved",
  ].join("\n");
  const withDesign = source.replace("## Region", "## Design\nKeep one adapter.\n\n## Region");
  const withoutReserved = withDesign.replace("\n\n## Gates\nreserved", "");
  const withoutRegionHeading = withoutReserved.replace("### Region heading\n", "");
  const withCriteriaEntry = withoutRegionHeading.replace("- flat criterion", "### Entry\nbody");
  const declared = withCriteriaEntry.replace("prose instead of a fence", "```bash\ntrue\n```");

  const firstFailure = (markdown: string): string => {
    try {
      decodeContractDocument(markdown);
    } catch (error) {
      assert.ok(error instanceof KeiyakuError);
      assert.equal(error.category, "invalid-input");
      return error.message;
    }
    return "accepted";
  };

  assert.equal(firstFailure(source), "contract document is missing ## Design");
  assert.equal(firstFailure(withDesign), "gates is not a contract Markdown section");
  assert.equal(firstFailure(withoutReserved), "Region may not contain a heading block");
  assert.equal(firstFailure(withoutRegionHeading), "Criteria must contain one or more H3 entries");
  assert.equal(firstFailure(withCriteriaEntry), "Verification must contain one or more fenced executor declarations");
  const repaired = decodeContractDocument(declared);
  assert.deepEqual(repaired.region, ["src/**"]);
  assert.deepEqual(repaired.criteria, [{ title: "Entry", body: "body\n\n" }]);
  assert.deepEqual(repaired.verification, [{ executor: "bash", script: "true" }]);
});

test("criteria bodies keep exact bytes through nested structure; duplicate titles are refused", () => {
  const body = decodeContractDocument(
    withCriteria(
      "### Keeps Bytes\nline one\r\n> quoted ## header\r\n- list body\r\n#### Detail\r\n~~~\r\n### fenced heading\r\n~~~\r\ntail\n### Last\nlast",
    ),
  );
  assert.deepEqual(body.criteria, [
    {
      title: "Keeps Bytes",
      body: "line one\r\n> quoted ## header\r\n- list body\r\n#### Detail\r\n~~~\r\n### fenced heading\r\n~~~\r\ntail\n",
    },
    { title: "Last", body: "last" },
  ]);
  assert.throws(() => decodeContractDocument(withCriteria("### First title\none\n\n###  FIRST   title \ntwo")), {
    name: "KeiyakuError",
    category: "invalid-input",
    message: "duplicate criterion 'FIRST   title'",
  });
  assert.throws(() => decodeContractDocument(withCriteria("stray\n### Entry\nbody")), {
    name: "KeiyakuError",
    category: "invalid-input",
    message: "Criteria may contain only H3 entries",
  });
  assert.throws(() => decodeContractDocument(withCriteria("### Empty\n  \r\n")), {
    name: "KeiyakuError",
    category: "invalid-input",
    message: "criterion 'Empty' is empty",
  });
});
