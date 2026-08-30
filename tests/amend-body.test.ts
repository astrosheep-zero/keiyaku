import assert from "node:assert/strict";
import test from "node:test";
import { applyAmendDocument } from "../src/body/amend.js";
import { decodeContractDocument } from "../src/body/decode.js";
import { renderContractBody } from "../src/body/render.js";
import type { ContractBody as ContractBodyValue } from "../src/body/types.js";

const body: ContractBodyValue = {
  title: "Current",
  context: "current\n",
  objective: "objective\n",
  design: "design\n",
  region: ["src/**"],
  criteria: [
    { title: "Keep", body: "before\n" },
    { title: "Drop", body: "remove\n" },
  ],
  verification: [{ executor: "bash", script: "true" }],
  extensions: [{ title: "Notes", content: "first\n" }],
};

function applyAmendOperations(source: string, current: ContractBodyValue) {
  const document = decodeContractDocument(renderContractBody(current));
  return decodeContractDocument(applyAmendDocument(source, document).document);
}

test("amend H2 operations form one complete body replacement", () => {
  const amended = applyAmendOperations(
    [
      "## Append: Context",
      "more",
      "",
      "## Replace: Region",
      "~~~",
      "lib/**",
      "~~~",
      "",
      "## Replace: Criteria",
      "### Keep",
      "before",
      "",
      "### Added",
      "added",
      "",
      "## Append: Notes",
      "second",
      "",
      "## Replace: Verification",
      "```zsh",
      "print ok",
      "```",
      "",
    ].join("\n"),
    body,
  );

  assert.equal(amended.context.trim(), "current\n\nmore");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [
      { title: "Keep", body: "before" },
      { title: "Added", body: "added" },
    ],
  );
  assert.deepEqual(amended.verification, [{ executor: "zsh", script: "print ok" }]);
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [{ title: "Notes", content: "first\n\nsecond" }],
  );
});

test("bare amend H2 headings replace existing sections and add new extensions", () => {
  const amended = applyAmendOperations(
    [
      "## Context",
      "bare context",
      "",
      "## Criteria",
      "### Bare criterion",
      "bare criterion body",
      "",
      "## Verification",
      "```bash",
      "echo bare",
      "```",
      "",
      "## Notes",
      "bare notes",
      "",
      "## Fresh notes",
      "new extension",
      "",
    ].join("\n"),
    body,
  );

  assert.equal(amended.context.trim(), "bare context");
  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [{ title: "Bare criterion", body: "bare criterion body" }],
  );
  assert.deepEqual(amended.verification, [{ executor: "bash", script: "echo bare" }]);
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [
      { title: "Notes", content: "bare notes" },
      { title: "Fresh notes", content: "new extension" },
    ],
  );
});

test("amend supports every ruled core, criterion, and extension operation", () => {
  const amended = applyAmendOperations(
    [
      "## Replace: Context",
      "replaced context",
      "",
      "## Append: Context",
      "appended context",
      "",
      "## Replace: Objective",
      "replaced objective",
      "",
      "## Append: Objective",
      "appended objective",
      "",
      "## Replace: Design",
      "replaced design",
      "",
      "## Append: Design",
      "appended design",
      "",
      "## Replace: Region",
      "~~~",
      "lib/**",
      "~~~",
      "",
      "## Replace: Criteria",
      "### Replace me",
      "replacement",
      "",
      "## Append: Criteria",
      "### Appended",
      "appended",
      "",
      "## Add: Criteria",
      "### Add me",
      "added",
      "",
      "## Replace: Verification",
      "```pwsh",
      "Write-Output ok",
      "```",
      "",
      "## Add: Added notes",
      "added extension",
      "",
      "## Append: Notes",
      "appended extension",
      "",
      "## Replace: Notes",
      "replaced extension",
      "",
      "## Update: Notes",
      "updated extension",
      "",
      "## Remove: Added notes",
      "",
    ].join("\n"),
    body,
  );

  assert.equal(amended.context.trim(), "replaced context\n\nappended context");
  assert.equal(amended.objective.trim(), "replaced objective\n\nappended objective");
  assert.equal(amended.design.trim(), "replaced design\n\nappended design");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [
      { title: "Replace me", body: "replacement" },
      { title: "Appended", body: "appended" },
      { title: "Add me", body: "added" },
    ],
  );
  assert.deepEqual(amended.verification, [{ executor: "pwsh", script: "Write-Output ok" }]);
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [{ title: "Notes", content: "updated extension" }],
  );
});

test("amend keeps criteria and extension collections coherent across ordered mutations", () => {
  const indexedBody: ContractBodyValue = {
    ...body,
    extensions: [...body.extensions, { title: "Archive", content: "archive\n" }],
  };
  const amended = applyAmendOperations(
    [
      "## Replace: Criteria",
      "### Replaced",
      "replacement",
      "",
      "## Append: Criteria",
      "### Appended",
      "appended",
      "",
      "## Add: Criteria",
      "### Added",
      "added",
      "",
      "## Remove: Notes",
      "",
      "## Update: Archive",
      "updated archive",
      "",
      "## Add: Extra",
      "first extra",
      "",
      "## Append: Extra",
      "second extra",
      "",
      "## Update: Extra",
      "updated extra",
      "",
      "## Replace: Extra",
      "replaced extra",
      "",
      "## Remove: Extra",
      "",
    ].join("\n"),
    indexedBody,
  );

  assert.deepEqual(
    amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })),
    [
      { title: "Replaced", body: "replacement" },
      { title: "Appended", body: "appended" },
      { title: "Added", body: "added" },
    ],
  );
  assert.deepEqual(
    amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })),
    [{ title: "Archive", content: "updated archive" }],
  );
});

test("amend has no criterion-level remove operation", () => {
  assert.throws(
    () => applyAmendOperations("## Remove: Criterion Keep\n", body),
    (error: unknown) => error instanceof TypeError && error.message === "unknown extension 'Criterion Keep'",
  );
});

test("amend cannot add a reserved H2 as an extension", () => {
  for (const title of ["Gates", "Pipeline", "After", "Arc", "Fulfillment"]) {
    assert.throws(
      () => applyAmendOperations(`## Add: ${title}\nvalue\n`, body),
      (error: unknown) =>
        error instanceof TypeError && error.message === `${title.toLowerCase()} is not a contract Markdown section`,
    );
  }
});

test("amend rejects a normalized extension-title collision at the operation boundary", () => {
  assert.throws(
    () => applyAmendOperations("## Add: notes\nsecond notes\n", body),
    (error: unknown) => error instanceof TypeError && error.message === "extension already exists 'notes'",
  );
});

test("explicit Replace still refuses a missing extension", () => {
  assert.throws(
    () => applyAmendOperations("## Replace: Fresh notes\nnew extension\n", body),
    (error: unknown) => error instanceof TypeError && error.message === "unknown extension 'Fresh notes'",
  );
});
