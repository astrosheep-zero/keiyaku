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
  const amended = applyAmendOperations([
    "## Append: Context",
    "more",
    "",
    "## Replace: Region",
    "~~~",
    "lib/**",
    "~~~",
    "",
    "## Add: Criteria",
    "### Added",
    "added",
    "",
    "## Remove: Criterion Drop",
    "",
    "## Append: Notes",
    "second",
    "",
    "## Replace: Verification",
    "```zsh",
    "print ok",
    "```",
    "",
  ].join("\n"), body);

  assert.equal(amended.context.trim(), "current\n\nmore");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })), [
    { title: "Keep", body: "before" },
    { title: "Added", body: "added" },
  ]);
  assert.deepEqual(amended.verification, [{ executor: "zsh", script: "print ok" }]);
  assert.deepEqual(amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })), [
    { title: "Notes", content: "first\n\nsecond" },
  ]);
});

test("amend supports every ruled core, criterion, and extension operation", () => {
  const amended = applyAmendOperations([
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
    "### Remove me",
    "remove",
    "",
    "## Add: Criteria",
    "### Add me",
    "added",
    "",
    "## Remove: Criterion Remove me",
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
  ].join("\n"), body);

  assert.equal(amended.context.trim(), "replaced context\n\nappended context");
  assert.equal(amended.objective.trim(), "replaced objective\n\nappended objective");
  assert.equal(amended.design.trim(), "replaced design\n\nappended design");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })), [
    { title: "Replace me", body: "replacement" },
    { title: "Add me", body: "added" },
  ]);
  assert.deepEqual(amended.verification, [{ executor: "pwsh", script: "Write-Output ok" }]);
  assert.deepEqual(amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })), [
    { title: "Notes", content: "updated extension" },
  ]);
});

test("amend keeps criterion and extension targets indexed across ordered mutations", () => {
  const indexedBody: ContractBodyValue = {
    ...body,
    extensions: [...body.extensions, { title: "Archive", content: "archive\n" }],
  };
  const amended = applyAmendOperations([
    "## Remove: Criterion Keep",
    "",
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
    "## Remove: Criterion Replaced",
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
  ].join("\n"), indexedBody);

  assert.deepEqual(amended.criteria.map(({ title, body }) => ({ title, body: body.trim() })), [
    { title: "Appended", body: "appended" },
    { title: "Added", body: "added" },
  ]);
  assert.deepEqual(amended.extensions.map(({ title, content }) => ({ title, content: content.trim() })), [
    { title: "Archive", content: "updated archive" },
  ]);
});

test("amend cannot add a reserved H2 as an extension", () => {
  for (const title of ["Gates", "Pipeline", "After", "Arc", "Fulfillment"]) {
    assert.throws(
      () => applyAmendOperations(`## Add: ${title}\nvalue\n`, body),
      (error: unknown) => error instanceof TypeError
        && error.message === `${title.toLowerCase()} is not a contract Markdown section`,
    );
  }
});

test("amend rejects a normalized extension-title collision at the operation boundary", () => {
  assert.throws(
    () => applyAmendOperations("## Add: notes\nsecond notes\n", body),
    (error: unknown) => error instanceof TypeError
      && error.message === "extension already exists 'notes'",
  );
});
