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

test("production TypeScript has a hard 20000-line architecture budget", () => {
  const atLimit = productionLineBudgetDiagnostic([
    { path: "core/limit.ts", source: "x\n".repeat(20_000) },
    { path: "scripts/ignored.ts", source: "x\n".repeat(10_000) },
  ]);
  assert.equal(atLimit, null);

  const overLimit = productionLineBudgetDiagnostic([
    { path: "core/over.ts", source: "x\n".repeat(20_001) },
  ]);
  assert.equal(overLimit?.rule, "architecture/production-line-budget");
  assert.equal(overLimit?.detail, "production TypeScript is 20001 lines; limit is 20000");
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

test("architecture policy keeps the Contract front door on protocol-owned operations", () => {
  const diagnostics = check({
    "git/repository.ts": "export function repositoryAt(): void {}",
    "core/verbs/attestation.ts": "export function decideAttestation(): void {}",
    "protocol/run.ts": "export function runProtocol(): void {}",
    "protocol/placement.ts": "export function admitPlacement(): void {}",
    "protocol/operations.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": [
      'import { repositoryAt } from "../git/repository.js";',
      'import { decideAttestation } from "../core/verbs/attestation.js";',
      'import { runProtocol } from "../protocol/run.js";',
      'import { admitPlacement } from "../protocol/placement.js";',
      'import { reviewOperation } from "../protocol/operations.js";',
      "export function facade(): void { repositoryAt(); decideAttestation(); runProtocol(); admitPlacement(); reviewOperation(); }",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 4);
});

test("architecture policy keeps the package-root facade composition-only", () => {
  const diagnostics = check({
    "protocol/operations.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": "export function reviewKeiyaku(): void {}",
    "library/keiyaku.ts": [
      'import { reviewOperation } from "../protocol/operations.js";',
      'import { reviewKeiyaku } from "./contract.js";',
      "export function facade(): void { reviewOperation(); reviewKeiyaku(); }",
    ].join("\n"),
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
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

test("architecture policy separates Heart schema, fact statements, and SQLite construction", () => {
  const typedSchema = check({
    "akuma/heart/schema.ts": [
      'import type { DatabaseSync } from "node:sqlite";',
      "export function version(database: DatabaseSync): void { void database; }",
    ].join("\n"),
  });
  assert.deepEqual(typedSchema, []);

  const typedRows = check({
    "akuma/heart/rows.ts": [
      'import type { DatabaseSync } from "node:sqlite";',
      "export function read(database: DatabaseSync): void { void database; }",
    ].join("\n"),
  });
  assert.deepEqual(typedRows, []);

  const runtimeRows = check({
    "akuma/heart/rows.ts": 'import { DatabaseSync } from "node:sqlite"; export const database = new DatabaseSync(":memory:");',
  });
  assert.ok(rules(runtimeRows).includes("architecture/capability-import"));

  const runtimeSchema = check({
    "akuma/heart/schema.ts": 'import { DatabaseSync } from "node:sqlite"; export const database = new DatabaseSync(":memory:");',
  });
  assert.ok(rules(runtimeSchema).includes("architecture/capability-import"));

  const statementInJudge = check({
    "akuma/heart/index.ts": 'export function judge(database: { prepare(sql: string): void }): void { database.prepare("SELECT 1"); }',
  });
  assert.equal(rules(statementInJudge).filter((rule) => rule === "architecture/forbidden-source-pattern").length, 2);
});

test("architecture policy gives activity codec directions exact runtime owners", () => {
  const provider = [
    "export function encodeAgentEvent(): void {}",
    "export function decodeAgentEvent(): void {}",
  ].join("\n");
  const accepted = check({
    "akuma/provider.ts": provider,
    "akuma/body.ts": 'import { encodeAgentEvent } from "./provider.js"; export const encode = encodeAgentEvent;',
    "akuma/akuma.ts": 'import { decodeAgentEvent } from "./provider.js"; export const decode = decodeAgentEvent;',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "akuma/provider.ts": provider,
    "akuma/body.ts": 'import { decodeAgentEvent } from "./provider.js"; export const decode = decodeAgentEvent;',
    "akuma/akuma.ts": 'import { encodeAgentEvent } from "./provider.js"; export const encode = encodeAgentEvent;',
  });
  assert.equal(rules(rejected).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy rejects dependency cycles including type-only cycles", () => {
  const diagnostics = check({
    "core/facts/a.ts": 'import type { B } from "./b.js"; export type A = B;',
    "core/facts/b.ts": 'import type { A } from "./a.js"; export type B = A;',
  });
  assert.ok(rules(diagnostics).includes("architecture/dependency-cycle"));
});

test("architecture policy keeps pure facts independent of Git", () => {
  const diagnostics = check({
    "git/repository.ts": "export type GitRepository = {};",
    "core/facts/fold.ts": 'import type { GitRepository } from "../../git/repository.js"; export function fold(repository: GitRepository): void {}',
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps verbs away from admission and repository", () => {
  const diagnostics = check({
    "git/admission.ts": "export type Offer = {};",
    "git/repository.ts": "export type GitRepository = {};",
    "core/verbs/deliver.ts": [
      'import type { Offer } from "../../git/admission.js";',
      'import type { GitRepository } from "../../git/repository.js";',
      "export function decideDeliver(offer: Offer, repository: GitRepository): void {}",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy permits protocol to join pact with Git", () => {
  const diagnostics = check({
    "core/decide.ts": "export type AttemptContext = {};",
    "git/repository.ts": "export type GitRepository = {};",
    "git/observe.ts": 'import type { GitRepository } from "./repository.js"; export function observeContractsForAdmission(repository: GitRepository): void { void repository; }',
    "protocol/attempt.ts": "export function admitDecidedOffer(): void {}",
    "protocol/run.ts": 'import { observeContractsForAdmission } from "../git/observe.js"; import type { GitRepository } from "../git/repository.js"; import type { AttemptContext } from "../core/decide.js"; import { admitDecidedOffer } from "./attempt.js"; export function run(repository: GitRepository, attempt: AttemptContext): void { observeContractsForAdmission(repository); void attempt; admitDecidedOffer(); }',
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy rejects former unread admission and fold readers", () => {
  const diagnostics = check({
    "core/facts/fold.ts": "export function foldJournal(): void {}",
    "git/admission.ts": 'import { foldJournal } from "../core/facts/fold.js"; export function admit(): void { foldJournal(); }',
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
    "core/facts/types.ts": "export type ContractId = string; export type ContractState = {}; export type SnapshotId = string;",
    "core/facts/gate.ts": "export function gateReports(): void {} export function gatesSatisfied(): void {}",
    "git/workspace.ts": "export function deliveryWorktreePath(): string { return \"\"; }",
    "protocol/read/status.ts": [
      'import { deliveryWorktreePath } from "../../git/workspace.js";',
      'import { gateReports } from "../../core/facts/gate.js";',
      'import type { ContractId, ContractState, SnapshotId } from "../../core/facts/types.js";',
      "export type ContractRow = { id: ContractId; candidate: SnapshotId | null };",
      "export type ContractBoard = { rows: readonly ContractRow[] };",
      "export function readContractBoard(state: ContractState): ContractBoard { void deliveryWorktreePath; gateReports(); void state; return { rows: [] }; }",
    ].join("\n"),
    "protocol/operations.ts": [
      'import { readContractBoard, type ContractBoard, type ContractRow } from "./read/status.js";',
      "export function contracts(): ContractBoard { return readContractBoard({}); }",
      "export type { ContractRow };",
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
    "git/repository.ts": "export const GIT_REF = ''; export function readRef(): void {} export function runGit(): void {} export type GitRepository = {};",
    "protocol/attempt.ts": 'import { GIT_REF, readRef, type GitRepository } from "../git/repository.js"; export function classify(repository: GitRepository): void { void GIT_REF; readRef(); void repository; }',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "git/repository.ts": "export function runGit(): void {}",
    "protocol/attempt.ts": 'import { runGit } from "../git/repository.js"; export function classify(): void { runGit(); }',
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
    "protocol/attempt.ts": "export function stamp(): number { return Date.now(); }",
    "library/contract.ts": "export function reject(): never { throw new TypeError('bad input'); }",
  });
  assert.deepEqual(rules(accepted).filter((r) => r === "architecture/capability-use"), []);

  const facadeTypeError = check({
    "library/keiyaku.ts": "export function reject(): never { throw new TypeError('bad input'); }",
  });
  assert.ok(rules(facadeTypeError).includes("architecture/capability-use"));

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

test("architecture policy uses specific zone before catch-all for Contract front door", () => {
  const diagnostics = check({
    "protocol/operations.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": 'import { reviewOperation } from "../protocol/operations.js"; export function facade(): void { reviewOperation(); }',
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy matches recursive wildcards between exact path segments", () => {
  const policy = {
    ...KEIYAKU_ARCHITECTURE_POLICY,
    zones: [
      { source: "feature/**/adapter.ts", allow: [{ target: "shared/**/types.ts" }] },
      { source: "**", allow: [] },
    ],
  };
  const accepted = checkArchitecture([
    { path: "feature/adapter.ts", source: 'import type { Value } from "../shared/types.js"; export type Result = Value;' },
    { path: "feature/nested/adapter.ts", source: 'import type { Value } from "../../shared/nested/types.js"; export type Result = Value;' },
    { path: "shared/types.ts", source: "export type Value = string;" },
    { path: "shared/nested/types.ts", source: "export type Value = string;" },
  ], policy);
  assert.deepEqual(accepted.diagnostics, []);

  const rejected = checkArchitecture([
    { path: "featurex/nested/adapter.ts", source: 'import type { Value } from "../../shared/nested/types.js"; export type Result = Value;' },
    { path: "feature/nested/other.ts", source: "export type Value = string;" },
    { path: "shared/nested/types.ts", source: "export type Value = string;" },
  ], policy);
  assert.deepEqual(rules(rejected.diagnostics), ["architecture/dependency-direction"]);
});
