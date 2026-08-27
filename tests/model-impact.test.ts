import assert from "node:assert/strict";
import test from "node:test";
import { analyzeModelImpact, type ModelSource } from "../scripts/model-impact/engine.js";
import { MODEL_IMPACT_POLICY } from "../scripts/model-impact/policy.js";

function source(path: string, value: string): ModelSource {
  return { path, source: value };
}

test("model impact reports semantic field reach across owners without failing on fan-out", () => {
  const base = [
    source("src/core/facts/types.ts", "export type ContractState = { delivery: string }"),
    source(
      "src/core/facts/fold.ts",
      'import type { ContractState } from "./types.js"; export function read(value: ContractState) { return value.delivery; }',
    ),
  ];
  const head = [
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
  assert.equal(report.fields.length, 1);
  assert.equal(report.fields[0]?.change, "changed");
  assert.deepEqual(report.fields[0]?.owners, ["cli", "core/facts"]);
  assert.deepEqual(
    new Set(report.fields[0]?.after?.usages.map((usage) => usage.kind)),
    new Set(["construct", "declaration", "destructure", "read", "write"]),
  );
});

test("model impact resolves inherited and aliased exported model fields", () => {
  const base = [
    source(
      "src/core/facts/types.ts",
      [
        "interface Shared<T> { readonly delivery: T }",
        "export interface ContractState extends Shared<string> {}",
        "export type ContractAlias = Shared<string>;",
        'export type Label = "open" | "done";',
      ].join("\n"),
    ),
  ];
  const head = [
    source(
      "src/core/facts/types.ts",
      [
        "interface Shared<T> { readonly delivery?: T }",
        "export interface ContractState extends Shared<number> {}",
        "export type ContractAlias = Shared<number>;",
        'export type Label = "open" | "done";',
      ].join("\n"),
    ),
  ];
  const report = analyzeModelImpact(base, head, { base: "base", head: "head" }, MODEL_IMPACT_POLICY);
  assert.deepEqual(
    report.fields.map((field) => field.model),
    ["ContractAlias", "ContractState"],
  );
  assert.ok(report.fields.every((field) => field.change === "changed"));
  assert.ok(report.fields.every((field) => field.after?.signature === "readonly optional number"));
});
