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

test("production TypeScript has a hard 9732-line architecture budget", () => {
  const atLimit = productionLineBudgetDiagnostic([
    { path: "core/limit.ts", source: "x\n".repeat(9_732) },
    { path: "scripts/ignored.ts", source: "x\n".repeat(10_000) },
  ]);
  assert.equal(atLimit, null);

  const overLimit = productionLineBudgetDiagnostic([
    { path: "core/over.ts", source: "x\n".repeat(9_733) },
  ]);
  assert.equal(overLimit?.rule, "architecture/production-line-budget");
  assert.match(overLimit?.detail ?? "", /9733 lines; limit is 9732/);
});

test("architecture policy accepts public command adapters", () => {
  const diagnostics = check({
    "index.ts": "export class Repo {}; export const Keiyaku = { bind(): undefined { return undefined; } };",
    "cli/parse.ts": "export type ParsedBind = { contract: string };",
    "cli/commands/bind.ts": [
      'import { Keiyaku, Repo } from "../../index.js";',
      'import type { ParsedBind } from "../parse.js";',
      "export function adapt(value: ParsedBind, repo: Repo): void { void value; Keiyaku.bind(); void repo; }",
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
    "protocol/intent.ts": "export function admitBind(): void {}",
    "cli/invoke.ts": 'import { admitBind } from "../protocol/intent.js"; export const invoke = admitBind;',
    "cli/commands/bind.ts": 'import { decideBind } from "../../core/verbs/bind.js"; export const bind = decideBind;',
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy keeps the library facade on protocol-owned operations", () => {
  const diagnostics = check({
    "carrier/repository.ts": "export function repositoryAt(): void {}",
    "core/verbs/attestation.ts": "export function decideAttestation(): void {}",
    "protocol/run.ts": "export function runProtocol(): void {}",
    "protocol/intent.ts": "export function admitPlacement(): void {}",
    "protocol/operations.ts": "export function reviewOperation(): void {}",
    "library/keiyaku.ts": [
      'import { repositoryAt } from "../carrier/repository.js";',
      'import { decideAttestation } from "../core/verbs/attestation.js";',
      'import { runProtocol } from "../protocol/run.js";',
      'import { admitPlacement } from "../protocol/intent.js";',
      'import { reviewOperation } from "../protocol/operations.js";',
      "export function facade(): void { repositoryAt(); decideAttestation(); runProtocol(); admitPlacement(); reviewOperation(); }",
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
    "core/decide.ts": "export type AttemptContext = {};",
    "carrier/repository.ts": "export type GitRepository = {};",
    "carrier/observe.ts": 'import type { GitRepository } from "./repository.js"; export function observeContractsForAdmission(repository: GitRepository): void { void repository; }',
    "protocol/attempt.ts": "export function admitDecidedOffer(): void {}",
    "protocol/run.ts": 'import { observeContractsForAdmission } from "../carrier/observe.js"; import type { GitRepository } from "../carrier/repository.js"; import type { AttemptContext } from "../core/decide.js"; import { admitDecidedOffer } from "./attempt.js"; export function run(repository: GitRepository, attempt: AttemptContext): void { observeContractsForAdmission(repository); void attempt; admitDecidedOffer(); }',
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy rejects former unread admission and fold readers", () => {
  const diagnostics = check({
    "core/facts/fold.ts": "export function foldJournal(): void {}",
    "carrier/admission.ts": 'import { foldJournal } from "../core/facts/fold.js"; export function admit(): void { foldJournal(); }',
    "protocol/run.ts": 'import { foldJournal } from "../core/facts/fold.js"; export function run(): void { foldJournal(); }',
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy keeps receipt folding out of operation orchestration", () => {
  const diagnostics = check({
    "core/facts/fold.ts": "export function foldJournal(): void {}",
    "protocol/operations.ts": 'import { foldJournal } from "../core/facts/fold.js"; export function complete(): void { foldJournal(); }',
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy permits the aggregate status read path", () => {
  const diagnostics = check({
    "core/facts/types.ts": "export type ContractStatus = {}; export type StatusReport = {}; export function gate(): string { return ''; }",
    "core/facts/gate.ts": "export function latestCurrentAttestations(): void {} export function gatesSatisfied(): void {}",
    "carrier/reconcile.ts": "export function deliveryWorktreePath(): string { return \"\"; }",
    "protocol/read/status.ts": [
      'import { deliveryWorktreePath } from "../../carrier/reconcile.js";',
      'import { latestCurrentAttestations } from "../../core/facts/gate.js";',
      'import { gate } from "../../core/facts/types.js";',
      'import type { ContractStatus, StatusReport } from "../../core/facts/types.js";',
      "export function readStatus(): StatusReport { void deliveryWorktreePath; void latestCurrentAttestations; void gate; return {} as StatusReport; }",
      "export type { ContractStatus };",
    ].join("\n"),
    "protocol/operations.ts": [
      'import { readStatus, type ContractStatus, type StatusReport } from "./read/status.js";',
      "export function status(): StatusReport { void (readStatus as () => StatusReport); return {} as StatusReport; }",
      "export type { ContractStatus };",
    ].join("\n"),
  });
  assert.deepEqual(diagnostics, []);

  const rejected = check({
    "core/facts/gate.ts": "export function gatesSatisfied(): void {}",
    "protocol/read/status.ts": 'import { gatesSatisfied } from "../../core/facts/gate.js"; export function readStatus(): void { gatesSatisfied(); }',
  });
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});

test("architecture policy limits publication retry observation to asserted refs", () => {
  const accepted = check({
    "carrier/repository.ts": "export const CARRIER_REF = ''; export function readRef(): void {} export function runGit(): void {} export type GitRepository = {};",
    "protocol/attempt.ts": 'import { CARRIER_REF, readRef, type GitRepository } from "../carrier/repository.js"; export function classify(repository: GitRepository): void { void CARRIER_REF; readRef(); void repository; }',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "carrier/repository.ts": "export function runGit(): void {}",
    "protocol/attempt.ts": 'import { runGit } from "../carrier/repository.js"; export function classify(): void { runGit(); }',
  });
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});

test("architecture policy keeps Markdown generic and contract grammar at the CLI edge", () => {
  const accepted = check({
    "core/facts/types.ts": "export type DocumentKey = string;",
    "body/types.ts": 'import type { DocumentKey } from "../core/facts/types.js"; export type ContractBody = { key: DocumentKey };',
    "markdown/types.ts": "export type Document = {};",
    "markdown/parse.ts": 'import type { Document } from "./types.js"; export function parse(): Document { return {}; }',
    "body/decode.ts": [
      'import type { ContractBody } from "./types.js";',
      'import { parse } from "../markdown/parse.js";',
      "export function decode(value: ContractBody): void { parse(); void value; }",
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
    "core/verbs/attestation.ts": "export const helper = 1; export function decideAttestation(): void {}",
  });
  const found = new Set(rules(diagnostics));
  assert.ok(found.has("architecture/removed-owner"));
  assert.ok(found.has("architecture/verb-owner"));
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/verb-owner").length, 3);
});

test("architecture policy rejects forbidden declaration patterns", () => {
  const diagnostics = check({
    "core/verbs/bind.ts": ["export function decideBind(): void {}", "export type OpenData = {};"].join("\n"),
  });
  assert.ok(rules(diagnostics).includes("architecture/removed-declaration"));
});

test("architecture policy rejects forbidden module imports", () => {
  const diagnostics = check({
    "cli/actor.ts": 'import Database from "better-sqlite3"; export function run(): void { void Database; }',
  });
  assert.ok(rules(diagnostics).includes("architecture/forbidden-module"));
});

test("architecture policy rejects capability use outside declared owners", () => {
  const accepted = check({
    "protocol/intent.ts": "export function stamp(): number { return Date.now(); }",
    "library/keiyaku.ts": "export function reject(): never { throw new TypeError('bad input'); }",
  });
  assert.deepEqual(rules(accepted).filter((r) => r === "architecture/capability-use"), []);

  const rejected = check({
    "core/facts/types.ts": "export function stamp(): number { return Date.now(); }",
  });
  assert.ok(rules(rejected).includes("architecture/capability-use"));

  const misplacedTypeError = check({
    "core/facts/types.ts": "export function reject(): never { throw new TypeError('bad state'); }",
  });
  assert.ok(rules(misplacedTypeError).includes("architecture/capability-use"));
});

test("architecture policy enforces symbol-scoped allowances", () => {
  const diagnostics = check({
    "core/subject.ts": "export function parseDependencyKeySet(): void {} export function other(): void {}",
    "core/facts/codec.ts": 'import { other } from "../subject.js"; export function codec(): void { other(); }',
  });
  assert.ok(rules(diagnostics).includes("architecture/dependency-direction"));
});

test("architecture policy uses specific zone before catch-all for library facade", () => {
  const diagnostics = check({
    "protocol/operations.ts": "export function reviewOperation(): void {}",
    "library/keiyaku.ts": 'import { reviewOperation } from "../protocol/operations.js"; export function facade(): void { reviewOperation(); }',
  });
  assert.deepEqual(diagnostics, []);
});
