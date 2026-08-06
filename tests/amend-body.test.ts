import assert from "node:assert/strict";
import test from "node:test";
import { applyAmendOperations } from "../src/body/amend.js";
import type { ContractBody as ContractBodyValue } from "../src/core/facts/types.js";

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
  gates: ["reviewed", "verified"],
  after: [],
};

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
    "## Update: Criterion Keep",
    "after",
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

  assert.equal(amended.context, "current\n\nmore\n");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(amended.criteria, [
    { title: "Keep", body: "after\n\n" },
    { title: "Added", body: "added\n\n" },
  ]);
  assert.deepEqual(amended.verification, [{ executor: "zsh", script: "print ok" }]);
  assert.deepEqual(amended.extensions, [{ title: "Notes", content: "first\n\nsecond\n" }]);
  assert.deepEqual(amended.gates, ["reviewed", "verified"]);
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
    "## Update: Criterion Replace me",
    "updated",
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

  assert.equal(amended.context, "replaced context\n\nappended context\n");
  assert.equal(amended.objective, "replaced objective\n\nappended objective\n");
  assert.equal(amended.design, "replaced design\n\nappended design\n");
  assert.deepEqual(amended.region, ["lib/**"]);
  assert.deepEqual(amended.criteria, [
    { title: "Replace me", body: "updated\n\n" },
    { title: "Add me", body: "added\n\n" },
  ]);
  assert.deepEqual(amended.verification, [{ executor: "pwsh", script: "Write-Output ok" }]);
  assert.deepEqual(amended.extensions, [{ title: "Notes", content: "updated extension\n\n" }]);
});
