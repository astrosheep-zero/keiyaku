import assert from "node:assert/strict";
import test from "node:test";
import { applyAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { decodeRegion, RegionDocumentError, regionsOverlap } from "../src/body/region.js";
import { renderContractBody } from "../src/body/render.js";
import { parseToAST } from "../src/markdown/parse.js";
import type { SectionNode } from "../src/markdown/types.js";

function region(patterns: readonly string[]): readonly string[] {
  const document = parseToAST(["## Region", "~~~", ...patterns, "~~~"].join("\n"));
  const section = document.children[0];
  assert.ok(section?.type === "section");
  return decodeRegion(document, section as SectionNode);
}

function contract(pattern: string): string {
  return [
    "# Region",
    "",
    "## Context",
    "context",
    "",
    "## Objective",
    "objective",
    "",
    "## Design",
    "design",
    "",
    "## Region",
    "~~~",
    pattern,
    "~~~",
    "",
    "## Criteria",
    "### Criterion",
    "criterion",
  ].join("\n");
}

test("Region accepts only its closed positive path grammar", () => {
  const accepted = [
    ["**"],
    ["src/*/file?.ts"],
    ["dir/**/nested"],
    ["literal.name"],
  ] as const;
  const refused = [
    ["/src"],
    ["src//file"],
    ["src/../file"],
    ["src/foo..bar"],
    ["src/**file"],
    ["src/***/file"],
    ["!src"],
    ["src/[file]"],
    ["src/{file}"],
  ] as const;

  for (const patterns of accepted) assert.deepEqual(region(patterns), patterns);
  assert.deepEqual(region(["src/"]), ["src/**"]);
  for (const patterns of refused) {
    assert.throws(() => region(patterns), RegionDocumentError);
  }
});

test("Region accepts only one closed unlabelled fence", () => {
  const refused = [
    "## Region\n~~~text\nsrc/**\n~~~",
    "## Region\n~~~\nsrc/**",
    "## Region\n~~~\nsrc/**\n~~~\nextra",
  ];
  for (const source of refused) {
    const document = parseToAST(source);
    const section = document.children[0];
    assert.ok(section?.type === "section");
    assert.throws(() => decodeRegion(document, section as SectionNode), RegionDocumentError);
  }
});

test("Region preserves nonblank pattern lines exactly", () => {
  assert.deepEqual(region(["src/file ", "", " src/other"]), ["src/file ", " src/other"]);
  assert.deepEqual(regionsOverlap(["src/file "], ["src/file"]), []);
});

test("contract rendering chooses a fence that preserves legal delimiter path bytes", () => {
  const decoded = decodeContractDocument(contract("```"));
  const rendered = renderContractBody(decoded);
  assert.deepEqual(decodeContractDocument(rendered).region, ["```"]);
});

test("contract decoding and amendment share Region validation", () => {
  const current = decodeContractDocument(contract("src/**"));
  assert.throws(
    () => decodeContractDocument(contract("src/**file")),
    (error: unknown) => error instanceof TypeError && error.message.includes("Region pattern 'src/**file' may use ** only as a complete segment"),
  );
  assert.throws(
    () => applyAmendDocument("## Replace: Region\n~~~\nsrc/**file\n~~~", current),
    (error: unknown) => error instanceof TypeError && error.message.includes("Region pattern 'src/**file' may use ** only as a complete segment"),
  );
});

test("Region intersection is exact across segment and character wildcards", () => {
  const cases = [
    { mine: ["src/file.ts"], theirs: ["src/file.ts"], expected: [["src/file.ts", "src/file.ts"]] },
    { mine: ["src/file.ts"], theirs: ["src/other.ts"], expected: [] },
    { mine: ["src/*"], theirs: ["src/?.ts"], expected: [["src/*", "src/?.ts"]] },
    { mine: ["src/a?c"], theirs: ["src/a*c"], expected: [["src/a?c", "src/a*c"]] },
    { mine: ["src/?.ts"], theirs: ["src/long.ts"], expected: [] },
    { mine: ["src/**"], theirs: ["src/nested/file.ts"], expected: [["src/**", "src/nested/file.ts"]] },
    { mine: ["src/*"], theirs: ["src/nested/file.ts"], expected: [] },
    { mine: ["**/file.ts"], theirs: ["src/nested/file.ts"], expected: [["**/file.ts", "src/nested/file.ts"]] },
    { mine: ["src/**"], theirs: ["tests/**"], expected: [] },
    { mine: ["src/a"], theirs: ["src/a/**"], expected: [["src/a", "src/a/**"]] },
  ] as const;

  for (const { mine, theirs, expected } of cases) {
    assert.deepEqual(regionsOverlap(mine, theirs), expected);
  }
});

test("Region intersection refuses patterns outside the closed grammar", () => {
  assert.throws(() => regionsOverlap(["src/**file"], ["src/file"]), RegionDocumentError);
});
