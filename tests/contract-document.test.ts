import assert from "node:assert/strict";
import test from "node:test";
import { decodeContractDocument } from "../src/body/decode.js";

function document(extra = ""): string {
  return [
    "# Day One",
    "",
    "## Context",
    "Current facts.",
    "",
    "## Objective",
    "Ship the CLI.",
    "",
    "## Design",
    "Keep one input adapter.",
    "",
    "## Region",
    "~~~",
    "src/cli/**",
    "tests/**",
    "~~~",
    "",
    "## Criteria",
    "### Parses the document",
    "The body is decoded once.",
    "",
    "### Retains extensions",
    "Unknown sections remain visible.",
    "",
    extra,
  ].join("\n");
}

function withCriteria(criteria: string): string {
  return [
    "# Day One",
    "",
    "## Context",
    "facts.",
    "",
    "## Objective",
    "ship.",
    "",
    "## Design",
    "adapter.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    criteria,
  ].join("\n");
}

test("contract Markdown decodes core fields and retains unknown H2 bytes", () => {
  const body = decodeContractDocument(document("## Rollout Notes\nfirst\n\n- second\n"));
  assert.equal(body.title, "Day One");
  assert.equal(body.context, "Current facts.\n\n");
  assert.deepEqual(body.region, ["src/cli/**", "tests/**"]);
  assert.deepEqual(body.criteria.map((criterion) => criterion.title), ["Parses the document", "Retains extensions"]);
  assert.deepEqual(body.extensions, [{ title: "Rollout Notes", content: "first\n\n- second\n" }]);
  assert.deepEqual(body.verification, []);
});

test("contract Markdown rejects frontmatter, duplicate sections, and missing structure", () => {
  assert.throws(
    () => decodeContractDocument(`---\nkind: contract\n---\n${document()}`),
    (error: unknown) => error instanceof TypeError && error.message.includes("contract document may not contain frontmatter"),
  );
  assert.throws(
    () => decodeContractDocument(`${document()}\n## context\nduplicate\n`),
    (error: unknown) => error instanceof TypeError && error.message.includes("duplicate contract section 'context'"),
  );
  assert.throws(
    () => decodeContractDocument("# Missing\n## Context\nonly one section\n"),
    (error: unknown) => error instanceof TypeError && error.message.includes("contract document is missing ## Objective"),
  );
});

test("Verification uses direct fenced executors and retired H2s are refused", () => {
  const verified = decodeContractDocument(`${document()}\n## Verification\n\`\`\`bash\ntrue\n\`\`\`\n`);
  assert.deepEqual(verified.verification, [{ executor: "bash", script: "true" }]);
  for (const name of ["Gates", "Pipeline", "After"]) {
    assert.throws(
      () => decodeContractDocument(`${document()}\n## ${name}\n- declaration\n`),
      (error: unknown) => error instanceof TypeError && error.message.includes(`${name.toLowerCase()} is not a contract Markdown section`),
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

test("unknown H2 extensions keep exact CRLF bytes and stop at the next H2", () => {
  const body = decodeContractDocument(
    [
      "# Day One",
      "",
      "## Context",
      "facts.",
      "",
      "## Rollout Notes",
      "first line\r",
      "> ## Quoted\r",
      "> more\r",
      "- ## Listed\r",
      "~~~\r",
      "## Fenced\r",
      "~~~\r",
      "last\r",
      "",
      "## Objective",
      "ship.",
      "",
      "## Design",
      "adapter.",
      "",
      "## Region",
      "~~~",
      "src/**",
      "~~~",
      "",
      "## Criteria",
      "### C1",
      "one",
    ].join("\n"),
  );
  assert.equal(body.context, "facts.\n\n");
  assert.equal(body.objective, "ship.\n\n");
  assert.deepEqual(body.extensions, [
    { title: "Rollout Notes", content: "first line\r\n> ## Quoted\r\n> more\r\n- ## Listed\r\n~~~\r\n## Fenced\r\n~~~\r\nlast\r\n\n" },
  ]);
});
