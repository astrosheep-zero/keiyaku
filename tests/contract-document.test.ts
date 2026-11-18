import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeContractDocument } from "../src/body/decode.js";
import { KeiyakuError } from "../src/errors.js";
import { renderContractBody } from "../src/body/render.js";

function document(extra = "", regionInfo = ""): string {
  return contractMarkdown("Day One", {
    Context: "Current facts.",
    Objective: "Ship the CLI.",
    Design: "Keep one input adapter.",
    Region: [`~~~${regionInfo}`, "src/cli/**", "tests/**", "~~~"].join("\n"),
    Criteria: [
      "### Parses the document",
      "The body is decoded once.",
      "",
      "### Retains extensions",
      "Unknown sections remain visible.",
      "",
      extra,
    ].join("\n"),
  });
}

function withCriteria(criteria: string): string {
  return contractMarkdown("Day One", {
    Context: "facts.",
    Objective: "ship.",
    Design: "adapter.",
    Region: "~~~\nsrc/**\n~~~",
    Criteria: [criteria].join("\n"),
  });
}

test("fixture Markdown preserves section order, fence bytes, and trailing newlines", () => {
  assert.equal(
    contractMarkdown("Fixture", { Region: "~~~txt\nsrc/**\n~~~", Criteria: "### one\nbody\n" }),
    "# Fixture\n\n## Region\n~~~txt\nsrc/**\n~~~\n\n## Criteria\n### one\nbody\n",
  );
  assert.equal(contractMarkdown("Empty", {}), "# Empty");
});

test("contract Markdown accepts the exact txt Region fence info string", () => {
  assert.deepEqual(decodeContractDocument(document("", "txt")).region, ["src/cli/**", "tests/**"]);
});

test("contract Markdown rejects frontmatter, duplicate sections, and missing structure", () => {
  assert.throws(
    () => decodeContractDocument(`---\ninvalid: [\n---\n${document()}`),
    (error: unknown) =>
      error instanceof KeiyakuError && error.category === "invalid-input" && error.name === "KeiyakuError",
  );
  assert.throws(
    () => decodeContractDocument(`---\nkind: contract\n---\n${document()}`),
    (error: unknown) =>
      error instanceof KeiyakuError &&
      error.category === "invalid-input" &&
      error.message.includes("contract document may not contain frontmatter"),
  );
  assert.throws(
    () => decodeContractDocument(`${document()}\n## context\nduplicate\n`),
    (error: unknown) =>
      error instanceof KeiyakuError && error.category === "invalid-input" && error.message.includes("duplicate contract section 'context'"),
  );
  assert.throws(
    () => decodeContractDocument("# Missing\n## Context\nonly one section\n"),
    (error: unknown) =>
      error instanceof KeiyakuError &&
      error.category === "invalid-input" &&
      error.message.includes("contract document is missing ## Objective"),
  );
  assert.throws(
    () =>
      decodeContractDocument(
        contractMarkdown("No Region", { Context: "facts.", Objective: "ship.", Design: "adapter." }),
      ),
    (error: unknown) =>
      error instanceof KeiyakuError && error.category === "invalid-input" && error.message.includes("contract document is missing ## Region"),
  );
});

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

test("contract Markdown refuses an empty required term and an empty extension", () => {
  const valid = {
    Context: "facts.",
    Objective: "ship.",
    Design: "adapter.",
    Region: "src/**",
    Criteria: "### one\nbody",
  };
  assert.throws(() => decodeContractDocument(contractMarkdown("Empty", { ...valid, Design: "  " })), {
    name: "KeiyakuError",
    category: "invalid-input",
    message: "contract section 'Design' is empty",
  });
  assert.throws(() => decodeContractDocument(contractMarkdown("Empty", { ...valid, Notes: "   " })), {
    name: "KeiyakuError",
    category: "invalid-input",
    message: "extension 'Notes' is empty",
  });
});

test("Verification uses direct fenced executors and reserved H2s are refused", () => {
  const verified = decodeContractDocument(`${document()}\n## Verification\n\`\`\`bash\ntrue\n\`\`\`\n`);
  assert.deepEqual(verified.verification, [{ executor: "bash", script: "true" }]);
  const timed = decodeContractDocument(`${document()}\n## Verification\n~~~bash timeout=25ms\ntrue\n~~~\n`);
  assert.deepEqual(timed.verification, [{ executor: "bash", script: "true", timeoutMs: 25 }]);
  const seconds = decodeContractDocument(`${document()}\n## Verification\n~~~bash timeout=60s\ntrue\n~~~\n`);
  assert.deepEqual(seconds.verification, [{ executor: "bash", script: "true", timeoutMs: 60_000 }]);
  assert.match(renderContractBody(seconds), /(?:```|~~~)bash timeout=1m\ntrue\n(?:```|~~~)/);
  assert.throws(
    () => decodeContractDocument(`${document()}\n## Verification\n~~~bash  timeout=25ms\ntrue\n~~~\n`),
    /optional timeout=<duration>/,
  );
  for (const duration of ["25", "1.5s", "01s", "1d"]) {
    assert.throws(
      () => decodeContractDocument(`${document()}\n## Verification\n~~~bash timeout=${duration}\ntrue\n~~~\n`),
      /integer duration with unit/,
    );
  }
  assert.throws(
    () => decodeContractDocument(`${document()}\n## Verification\n~~~bash timeout=0s\ntrue\n~~~\n`),
    /must be positive/,
  );
  for (const name of ["Gates", "Pipeline", "After", "Arc", "Fulfillment"]) {
    assert.throws(
      () => decodeContractDocument(`${document()}\n## ${name}\n- declaration\n`),
      (error: unknown) =>
        error instanceof KeiyakuError &&
        error.category === "invalid-input" &&
        error.message.includes(`${name.toLowerCase()} is not a contract Markdown section`),
    );
  }
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
