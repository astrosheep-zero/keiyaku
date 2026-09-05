import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { applyAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { decodeRegion, regionWarnings, RegionDocumentError, regionsOverlap } from "../src/body/region.js";
import { renderContractBody } from "../src/body/render.js";
import { parseToAST } from "../src/markdown/parse.js";
import type { SectionNode } from "../src/markdown/types.js";

function region(patterns: readonly string[], info = ""): readonly string[] {
  const document = parseToAST(["## Region", `~~~${info}`, ...patterns, "~~~"].join("\n"));
  const section = document.children[0];
  assert.ok(section?.type === "section");
  return decodeRegion(document, section as SectionNode);
}

function contract(pattern: string, regionInfo = ""): string {
  return contractMarkdown("Region", {
    Context: "context",
    Objective: "objective",
    Design: "design",
    Region: [`~~~${regionInfo}`, pattern, "~~~"].join("\n"),
    Criteria: "### Criterion\ncriterion",
  });
}

test("Region accepts only its closed positive path grammar", () => {
  const accepted = [["**"], ["src/*/file?.ts"], ["dir/**/nested"], ["literal.name"]] as const;
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

test("Region accepts one fence with no info string or the exact txt, and refuses an unclosed fence", () => {
  assert.deepEqual(region(["src/**"]), ["src/**"]);
  assert.deepEqual(region(["src/**"], "txt"), ["src/**"]);
  const invalidLabels = [
    "## Region\n~~~text\nsrc/**\n~~~",
    "## Region\n~~~TXT\nsrc/**\n~~~",
    "## Region\n~~~txt extra\nsrc/**\n~~~",
  ];
  for (const source of invalidLabels) {
    const document = parseToAST(source);
    const section = document.children[0];
    assert.ok(section?.type === "section");
    assert.throws(
      () => decodeRegion(document, section as SectionNode),
      (error: unknown) =>
        error instanceof RegionDocumentError && error.message.includes("info string other than the exact 'txt'"),
    );
  }

  const unclosed = parseToAST("## Region\n~~~\nsrc/**");
  const unclosedSection = unclosed.children[0];
  assert.ok(unclosedSection?.type === "section");
  assert.throws(
    () => decodeRegion(unclosed, unclosedSection as SectionNode),
    (error: unknown) => error instanceof RegionDocumentError && error.message === "Region fence must be closed",
  );
});

test("Region decodes fences, list items, and bare lines to the same patterns and unions them", () => {
  const decode = (source: string) => {
    const document = parseToAST(source);
    const section = document.children[0];
    assert.ok(section?.type === "section");
    return decodeRegion(document, section as SectionNode);
  };

  assert.deepEqual(decode("## Region\n~~~\nsrc/a\nsrc/b\n~~~"), ["src/a", "src/b"]);
  assert.deepEqual(decode("## Region\n- src/a\n- src/b\n"), ["src/a", "src/b"]);
  assert.deepEqual(decode("## Region\nsrc/a\nsrc/b\n"), ["src/a", "src/b"]);
  assert.deepEqual(decode("## Region\n~~~\nsrc/a\n~~~\n\n- src/b\n"), ["src/a", "src/b"]);
  assert.deepEqual(decode("## Region\n~~~\nsrc/a\n~~~\nextra\n"), ["src/a", "extra"]);
  assert.deepEqual(decode("## Region\n\n\nsrc/a\n\n"), ["src/a"]);
});

test("Region refuses foreign block kinds by name", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["## Region\n### heading\n", "Region may not contain a heading block"],
    ["## Region\n> quoted\n", "Region may not contain a blockquote block"],
    ["## Region\n---\n", "Region may not contain a thematic break block"],
    ["## Region\n<div>\n", "Region may not contain an HTML block"],
    ["## Region\n| path | note |\n| --- | --- |\n| src/** | x |\n", "Region may not contain a table block"],
  ];
  for (const [source, diagnostic] of cases) {
    const document = parseToAST(source);
    const section = document.children[0];
    assert.ok(section?.type === "section");
    assert.throws(
      () => decodeRegion(document, section as SectionNode),
      (error: unknown) => error instanceof RegionDocumentError && error.message === diagnostic,
    );
  }
});

test("Region pattern whitespace warns without rejecting", () => {
  assert.deepEqual(regionWarnings(["src/a b"]), [
    "Region pattern 'src/a b' contains whitespace and will never match a path",
  ]);
  assert.deepEqual(regionWarnings(["src/a", "docs/**"]), []);
  assert.deepEqual(region(["src/a b"]), ["src/a b"]);
});

test("Region preserves nonblank pattern lines exactly", () => {
  assert.deepEqual(region(["src/file ", "", " src/other"]), ["src/file ", " src/other"]);
  assert.deepEqual(regionsOverlap(["src/file "], ["src/file"]), []);
});

test("contract rendering writes Region as canonical bare lines", () => {
  const decoded = decodeContractDocument(contract("src/```.ts"));
  const rendered = renderContractBody(decoded);
  assert.match(rendered, /\n## Region\n\nsrc\/```\.ts\n/u);
  assert.deepEqual(decodeContractDocument(rendered).region, ["src/```.ts"]);
});

test("contract decoding and amendment share Region validation", () => {
  const current = decodeContractDocument(contract("src/**"));
  assert.deepEqual(decodeContractDocument(contract("src/**", "txt")).region, ["src/**"]);
  const amendment = applyAmendDocument("## Replace: Region\n~~~txt\ntests/**\n~~~", current);
  assert.deepEqual(decodeContractDocument(amendment.document).region, ["tests/**"]);
  assert.deepEqual([...amendment.changedSections], ["region"]);
  assert.throws(
    () => decodeContractDocument(contract("src/**file")),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes("Region pattern 'src/**file' may use ** only as a complete segment"),
  );
  assert.throws(
    () => applyAmendDocument("## Replace: Region\n~~~\nsrc/**file\n~~~", current),
    (error: unknown) =>
      error instanceof TypeError &&
      error.message.includes("Region pattern 'src/**file' may use ** only as a complete segment"),
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
