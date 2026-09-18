import assert from "node:assert/strict";
import test from "node:test";
import { analyzeModelImpact, type ModelSource } from "../scripts/model-impact/engine.js";
import { MODEL_IMPACT_POLICY } from "../scripts/model-impact/policy.js";

function source(path: string, value: string): ModelSource {
  return { path, source: value };
}

test("model impact tracks owner usages, inherited aliases and replaced source roots", () => {
  const inherited = (type: string, optional: string) =>
    source(
      "src/core/facts/inherited.ts",
      [
        `interface Shared<T> { readonly delivery${optional}: T }`,
        `export interface ContractState extends Shared<${type}> {}`,
        `export type ContractAlias = Shared<${type}>;`,
        'export type Label = "open" | "done";',
      ].join("\n"),
    );
  const base = [
    source("src/core/facts/deleted.ts", "export interface Deleted { retired: string }"),
    inherited("string", ""),
    source("src/core/facts/types.ts", "export type ContractState = { delivery: string }"),
    source(
      "src/core/facts/fold.ts",
      'import type { ContractState } from "./types.js"; export function read(value: ContractState) { return value.delivery; }',
    ),
  ];
  const head = [
    source("src/core/facts/added.ts", "export interface Added { fresh: number }"),
    inherited("number", "?"),
    source("src/core/facts/types.ts", "export type ContractState = { delivery?: number }"),
    source(
      "src/core/facts/fold.ts",
      [
        'import type { ContractState } from "./types.js";',
        'export function read(value: ContractState) { value["delivery"] = 1; return value.delivery; }',
        "export function construct(): ContractState { return { delivery: 1 }; }",
      ].join("\n"),
    ),
    source(
      "src/cli/invoke.ts",
      'import type { ContractState } from "../core/facts/types.js"; export function render(value: ContractState) { const { delivery } = value; return delivery; }',
    ),
  ];
  const report = analyzeModelImpact(base, head, { base: "base", head: "head" }, MODEL_IMPACT_POLICY);
  assert.deepEqual(
    report.fields.map((field) => [field.model, field.change]),
    [
      ["Added", "added"],
      ["Deleted", "removed"],
      ["ContractAlias", "changed"],
      ["ContractState", "changed"],
      ["ContractState", "changed"],
    ],
  );
  assert.equal(report.fields[0]?.before, undefined);
  assert.equal(report.fields[1]?.after, undefined);
  const inheritedFields = report.fields.filter((field) => field.file === "src/core/facts/inherited.ts");
  assert.equal(inheritedFields.length, 2);
  assert.ok(inheritedFields.every((field) => field.before?.signature === "readonly string"));
  assert.ok(inheritedFields.every((field) => field.after?.signature === "readonly optional number"));
  const changed = report.fields.find((field) => field.file === "src/core/facts/types.ts");
  assert.ok(changed);
  assert.deepEqual(changed.owners, ["cli", "core/facts"]);
  assert.deepEqual(
    new Set(changed.after?.usages.map((usage) => usage.kind)),
    new Set(["construct", "declaration", "destructure", "read", "write"]),
  );
});
