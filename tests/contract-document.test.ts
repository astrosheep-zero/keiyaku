import { contractMarkdown } from "./support/markdown.js";
import assert from "node:assert/strict";
import test from "node:test";
import { decodeContractDocument } from "../src/body/decode.js";
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
    (error: unknown) => error instanceof TypeError && error.name === "TypeError",
  );
  assert.throws(
    () => decodeContractDocument(`---\nkind: contract\n---\n${document()}`),
    (error: unknown) =>
      error instanceof TypeError && error.message.includes("contract document may not contain frontmatter"),
  );
  assert.throws(
    () => decodeContractDocument(`${document()}\n## context\nduplicate\n`),
    (error: unknown) => error instanceof TypeError && error.message.includes("duplicate contract section 'context'"),
  );
  assert.throws(
    () => decodeContractDocument("# Missing\n## Context\nonly one section\n"),
    (error: unknown) =>
      error instanceof TypeError && error.message.includes("contract document is missing ## Objective"),
  );
  assert.throws(
    () =>
      decodeContractDocument(
        contractMarkdown("No Region", { Context: "facts.", Objective: "ship.", Design: "adapter." }),
      ),
    (error: unknown) => error instanceof TypeError && error.message.includes("contract document is missing ## Region"),
  );
});

test("contract Markdown reports independent structural diagnostics together", () => {
  const malformed = [
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
  assert.throws(
    () => decodeContractDocument(malformed),
    (error: unknown) => {
      if (!(error instanceof TypeError)) return false;
      assert.equal(
        error.message,
        [
          "contract document is missing ## Design",
          "gates is not a contract Markdown section",
          "Region may not contain a heading block",
          "Criteria must contain one or more H3 entries",
          "Verification must contain one or more fenced executor declarations",
        ].join("\n"),
      );
      return true;
    },
  );
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
        error instanceof TypeError &&
        error.message.includes(`${name.toLowerCase()} is not a contract Markdown section`),
    );
  }
});

test("criteria bodies keep exact bytes through nested structure; duplicate titles are refused", () => {
  const body = decodeContractDocument(
    withCriteria("### Keeps Bytes\nline one\r\n> quoted ## header\r\n- list body\r\n~~~\r\nfence body\r\n~~~\r\ntail"),
  );
  assert.deepEqual(body.criteria, [
    { title: "Keeps Bytes", body: "line one\r\n> quoted ## header\r\n- list body\r\n~~~\r\nfence body\r\n~~~\r\ntail" },
  ]);
  assert.throws(
    () => decodeContractDocument(withCriteria("### First\none\n\n###  FIRST \ntwo")),
    (error: unknown) => error instanceof TypeError && error.message.includes("duplicate criterion 'FIRST'"),
  );
});
