import assert from "node:assert/strict";
import test from "node:test";
import { checkArchitecture, type Diagnostic, type SourceInput } from "../scripts/architecture/engine.js";
import { KEIYAKU_ARCHITECTURE_POLICY } from "../scripts/architecture/policy.js";
import { productionLineBudgetDiagnostic } from "../scripts/check-architecture.js";

function check(files: Readonly<Record<string, string>>): readonly Diagnostic[] {
  const inputs: SourceInput[] = Object.entries(files).map(([path, source]) => ({ path, source }));
  return checkArchitecture(inputs, KEIYAKU_ARCHITECTURE_POLICY).diagnostics;
}

function rules(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics.map((diagnostic) => diagnostic.rule);
}

test("production TypeScript has a hard 7000-line architecture budget", () => {
  const atLimit = productionLineBudgetDiagnostic([
    { path: "core/limit.ts", source: "x\n".repeat(7_000) },
    { path: "scripts/ignored.ts", source: "x\n".repeat(10_000) },
  ]);
  assert.equal(atLimit, null);

  const overLimit = productionLineBudgetDiagnostic([
    { path: "core/over.ts", source: "x\n".repeat(7_001) },
  ]);
  assert.equal(overLimit?.rule, "architecture/production-line-budget");
  assert.match(overLimit?.detail ?? "", /7001 lines; limit is 7000/);
});

test("architecture policy accepts public command adapters", () => {
  const diagnostics = check({
    "index.ts": "export class Keiyaku { static bind(): void {} }",
    "cli/parse.ts": "export type ParsedBind = { contract: string };",
    "cli/commands/bind.ts": [
      'import { Keiyaku } from "../../index.js";',
      'import type { ParsedBind } from "../parse.js";',
      "export function adapt(value: ParsedBind): void { void value; Keiyaku.bind(); }",
    ].join("\n"),
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy rejects runtime orchestration and an unowned task pillar", () => {
  const diagnostics = check({
    "core/verbs/bind.ts": "export function decideBind(): void {}",
    "cli/commands/bind.ts": 'import { decideBind } from "../../core/verbs/bind.js"; export const adapt = decideBind;',
    "task/model.ts": "export type TaskId = string;",
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction", "architecture/unowned-source"]);
});

test("architecture policy keeps invoke and contract commands off the private lifecycle path", () => {
  const diagnostics = check({
    "core/verbs/bind.ts": "export function decideBind(): void {}",
    "protocol/intent.ts": "export function runIntent(): void {}",
    "cli/invoke.ts": 'import { runIntent } from "../protocol/intent.js"; export const invoke = runIntent;',
    "cli/commands/bind.ts": 'import { decideBind } from "../../core/verbs/bind.js"; export const bind = decideBind;',
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy keeps the library facade on protocol-owned operations", () => {
  const diagnostics = check({
    "carrier/repository.ts": "export function repositoryAt(): void {}",
    "core/verbs/review.ts": "export function decideReview(): void {}",
    "protocol/run.ts": "export function runProtocol(): void {}",
    "protocol/intent.ts": "export function admitReview(): void {}",
    "protocol/operations.ts": "export function reviewOperation(): void {}",
    "library/keiyaku.ts": [
      'import { repositoryAt } from "../carrier/repository.js";',
      'import { decideReview } from "../core/verbs/review.js";',
      'import { runProtocol } from "../protocol/run.js";',
      'import { admitReview } from "../protocol/intent.js";',
      'import { reviewOperation } from "../protocol/operations.js";',
      "export function facade(): void { repositoryAt(); decideReview(); runProtocol(); admitReview(); reviewOperation(); }",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 4);
});

test("architecture policy keeps the package root on library exports only", () => {
  const diagnostics = check({
    "body/decode.ts": "export const decode = (): void => {};",
    "core/facts/types.ts": "export type ContractId = string;",
    "library/keiyaku.ts": "export class Keiyaku {}",
    "index.ts": [
      'import { decode } from "./body/decode.js";',
      'import type { ContractId } from "./core/facts/types.js";',
      'import { Keiyaku } from "./library/keiyaku.js";',
      "export const root = [decode, Keiyaku] as const;",
      "export type Id = ContractId;",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy reserves asynchronous process spawn for runtime/proc", () => {
  const accepted = check({
    "runtime/proc/run.ts": 'import { spawn } from "node:child_process"; export function run(): void { void spawn; }',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "cli/actor.ts": 'import { spawn } from "node:child_process"; export function run(): void { void spawn; }',
  });
  assert.deepEqual(rules(rejected), ["architecture/capability-import"]);
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
    "carrier/repository.ts": "export type GitRepository = {};",
    "core/facts/fold.ts": 'import type { GitRepository } from "../../carrier/repository.js"; export function fold(repository: GitRepository): void {}',
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps verbs away from admission and repository", () => {
  const diagnostics = check({
    "carrier/admission.ts": "export type Offer = {};",
    "carrier/repository.ts": "export type GitRepository = {};",
    "core/verbs/deliver.ts": [
      'import type { Offer } from "../../carrier/admission.js";',
      'import type { GitRepository } from "../../carrier/repository.js";',
      "export function decideDeliver(offer: Offer, repository: GitRepository): void {}",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy permits protocol to join pact with carrier", () => {
  const diagnostics = check({
    "core/facts/types.ts": "export type ContractId = string;",
    "core/facts/observation.ts": 'import type { ContractId } from "./types.js"; export type Observation = ContractId;',
    "carrier/repository.ts": "export type GitRepository = {};",
    "carrier/observe.ts": 'import type { Observation } from "../core/facts/observation.js"; import type { GitRepository } from "./repository.js"; export function observe(repository: GitRepository): Observation { return repository as Observation; }',
    "protocol/run.ts": 'import { observe } from "../carrier/observe.js"; import type { GitRepository } from "../carrier/repository.js"; export function run(repository: GitRepository): void { observe(repository); }',
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy permits the aggregate status read path", () => {
  const diagnostics = check({
    "core/facts/types.ts": "export type ContractStatus = {}; export type StatusReport = {};",
    "carrier/reconcile.ts": "export function deliveryWorktreePath(): string { return \"\"; }",
    "protocol/read/status.ts": [
      'import { deliveryWorktreePath } from "../../carrier/reconcile.js";',
      'import type { ContractStatus, StatusReport } from "../../core/facts/types.js";',
      "export function readStatus(): StatusReport { void deliveryWorktreePath; return {} as StatusReport; }",
      "export type { ContractStatus };",
    ].join("\n"),
    "protocol/operations.ts": [
      'import { readStatus, type ContractStatus, type StatusReport } from "./read/status.js";',
      "export function status(): StatusReport { void (readStatus as () => StatusReport); return {} as StatusReport; }",
      "export type { ContractStatus };",
    ].join("\n"),
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy keeps Markdown generic and contract grammar at the CLI edge", () => {
  const accepted = check({
    "core/facts/types.ts": "export type ContractBody = {};",
    "core/facts/codec.ts": 'import type { ContractBody } from "./types.js"; export function validate(value: ContractBody): void {}',
    "markdown/types.ts": "export type Document = {};",
    "markdown/parse.ts": 'import type { Document } from "./types.js"; export function parse(): Document { return {}; }',
    "body/decode.ts": [
      'import { validate } from "../core/facts/codec.js";',
      'import type { ContractBody } from "../core/facts/types.js";',
      'import { parse } from "../markdown/parse.js";',
      "export function decode(value: ContractBody): void { parse(); validate(value); }",
    ].join("\n"),
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "core/facts/types.ts": "export type ContractBody = {};",
    "cli/parse.ts": "export type Parsed = {};",
    "markdown/parse.ts": 'import type { ContractBody } from "../core/facts/types.js"; export type Leaked = ContractBody;',
    "body/decode.ts": 'import type { Parsed } from "../cli/parse.js"; export type Leaked = Parsed;',
  });
  assert.equal(rules(rejected).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy rejects imports between verbs", () => {
  const diagnostics = check({
    "core/verbs/bind.ts": "export type BindInput = {}; export function decideBind(): void {}",
    "core/verbs/deliver.ts": [
      'import type { BindInput } from "./bind.js";',
      "export function decideDeliver(value: BindInput): void {}",
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
