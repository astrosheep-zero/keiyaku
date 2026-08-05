import assert from "node:assert/strict";
import test from "node:test";
import { checkArchitecture, type Diagnostic, type SourceInput } from "../scripts/architecture/engine.js";
import { KEIYAKU_ARCHITECTURE_POLICY } from "../scripts/architecture/policy.js";

function check(files: Readonly<Record<string, string>>): readonly Diagnostic[] {
  const inputs: SourceInput[] = Object.entries(files).map(([path, source]) => ({ path, source }));
  return checkArchitecture(inputs, KEIYAKU_ARCHITECTURE_POLICY).diagnostics;
}

function rules(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.rule);
}

test("architecture policy accepts typed command adapters and task identity imports", () => {
  const diagnostics = check({
    "core/facts/types.ts": [
      "export type ContractId = string;",
      "export type TaskId = string;",
      "export function contractId(value: string): ContractId { return value; }",
      "export function taskCoordinates(value: TaskId) { return { namespace: value, local: value }; }",
    ].join("\n"),
    "core/verbs/bind.ts": [
      'import type { ContractId } from "../facts/types.js";',
      "export type BindInput = { contract: ContractId };",
      "export function decideBind(): void {}",
    ].join("\n"),
    "cli/parse.ts": "export type ParsedBind = { contract: string };",
    "cli/commands/bind.ts": [
      'import { contractId } from "../../core/facts/types.js";',
      'import type { BindInput } from "../../core/verbs/bind.js";',
      'import type { ParsedBind } from "../parse.js";',
      "export function adapt(value: ParsedBind): BindInput { return { contract: contractId(value.contract) }; }",
    ].join("\n"),
    "task/query.ts": [
      'import { taskCoordinates, type TaskId } from "../core/facts/types.js";',
      "export function locate(task: TaskId): string { return taskCoordinates(task).local; }",
    ].join("\n"),
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy rejects runtime orchestration and contract-aware task imports", () => {
  const diagnostics = check({
    "core/facts/types.ts": "export type ContractState = {};",
    "core/verbs/bind.ts": "export function decideBind(): void {}",
    "cli/commands/bind.ts": 'import { decideBind } from "../../core/verbs/bind.js"; export const adapt = decideBind;',
    "task/query.ts": 'import type { ContractState } from "../core/facts/types.js"; export type Leaked = ContractState;',
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy rejects dependency cycles including type-only cycles", () => {
  const diagnostics = check({
    "core/facts/a.ts": 'import type { B } from "./b.js"; export type A = B;',
    "core/facts/b.ts": 'import type { A } from "./a.js"; export type B = A;',
  });
  assert.ok(rules(diagnostics).includes("architecture/dependency-cycle"));
});

test("architecture policy keeps pure facts independent of Git transport", () => {
  const diagnostics = check({
    "core/facts/repository.ts": "export type GitRepository = {};",
    "core/facts/fold.ts": 'import type { GitRepository } from "./repository.js"; export function fold(repository: GitRepository): void {}',
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps verbs away from admission and repository", () => {
  const diagnostics = check({
    "core/facts/admission.ts": "export type Offer = {};",
    "core/facts/repository.ts": "export type GitRepository = {};",
    "core/verbs/deliver.ts": [
      'import type { Offer } from "../facts/admission.js";',
      'import type { GitRepository } from "../facts/repository.js";',
      "export function decideDeliver(offer: Offer, repository: GitRepository): void {}",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy rejects imports between verbs", () => {
  const diagnostics = check({
    "core/verbs/bind.ts": "export function decideBind(): void {}",
    "core/verbs/deliver.ts": [
      'import type { DecideBind } from "./bind.js";',
      "export function decideDeliver(value: DecideBind): void {}",
    ].join("\n"),
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy rejects misplaced capabilities and unresolved imports", () => {
  const diagnostics = check({
    "core/verbs/bind.ts": [
      'import { readFileSync } from "node:fs";',
      'import { readFile } from "fs/promises";',
      'import { createRequire } from "node:module";',
      'import "../facts/missing.js";',
      "export function decideBind(): void { readFileSync(0); void readFile; void createRequire; }",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/capability-import").length, 3);
  assert.ok(rules(diagnostics).includes("architecture/unresolved-import"));
});

test("architecture policy enforces source and function structure limits", () => {
  const longBody = "  void 0;\n".repeat(80);
  const branches = Array.from({ length: 20 }, (_, index) => `  if (value === ${index}) return ${index};`).join("\n");
  const diagnostics = check({
    "core/facts/large.ts": `export function large() {\n${longBody}}\n${"\n".repeat(520)}`,
    "core/facts/complex.ts": `export function complex(value: number) {\n${branches}\n  return -1;\n}`,
    "core/facts/nested.ts": "export function nested(a: boolean) { if (a) { while (a) { try { if (a) { for (;;) { break; } } } catch {} } } }",
    "core/facts/parameters.ts": "export function many(a: 1, b: 2, c: 3, d: 4, e: 5, f: 6): void {}",
    "core/facts/duplicate-a.ts": `export function first(value: number): number {\n${"  value += 1;\n".repeat(12)}  return value;\n}`,
    "core/facts/duplicate-b.ts": `export function second(value: number): number {\n${"  value += 1;\n".repeat(12)}  return value;\n}`,
  });
  const found = new Set(rules(diagnostics));
  assert.ok(found.has("maintainability/file-lines"));
  assert.ok(found.has("maintainability/function-lines"));
  assert.ok(found.has("maintainability/complexity"));
  assert.ok(found.has("maintainability/nesting"));
  assert.ok(found.has("maintainability/parameters"));
  assert.ok(found.has("maintainability/duplicate-function"));
});

test("architecture policy rejects removed owners and malformed verb owners", () => {
  const diagnostics = check({
    "core/verbs/open.ts": "export async function decideAnything(): Promise<void> {}",
    "core/verbs/bind.ts": "export const decideBind = async (): Promise<void> => {};",
    "core/verbs/review.ts": "export const helper = 1; export function decideReview(): void {}",
  });
  const found = new Set(rules(diagnostics));
  assert.ok(found.has("architecture/removed-owner"));
  assert.ok(found.has("architecture/verb-owner"));
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/verb-owner").length, 3);
});
