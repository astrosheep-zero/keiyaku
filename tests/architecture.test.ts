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

test("architecture policy keeps request and body edges symbol-scoped", () => {
  const diagnostics = check({
    "akuma/request-wire.ts": "export const unlisted = undefined;",
    "akuma/heart/index.ts": "export const unlisted = undefined;",
    "akuma/requests.ts": 'import { unlisted } from "./request-wire.js"; export { unlisted };',
    "akuma/request-serve.ts": 'import { unlisted } from "./heart/index.js"; export { unlisted };',
    "akuma/body.ts": 'import { unlisted } from "./request-serve.js"; export { unlisted };',
    "akuma-body.ts": 'import { unlisted } from "./akuma/body.js"; export { unlisted };',
  });
  assert.deepEqual(rules(diagnostics), Array(4).fill("architecture/dependency-direction"));
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
    "protocol/review.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": [
      'import { repositoryAt } from "../git/repository.js";',
      'import { decideAttestation } from "../core/verbs/attestation.js";',
      'import { runProtocol } from "../protocol/run.js";',
      'import { admitPlacement } from "../protocol/placement.js";',
      'import { reviewOperation } from "../protocol/review.js";',
      "export function facade(): void { repositoryAt(); decideAttestation(); runProtocol(); admitPlacement(); reviewOperation(); }",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 4);
});

test("architecture policy keeps the package-root facade composition-only", () => {
  const diagnostics = check({
    "protocol/review.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": "export function reviewKeiyaku(): void {}",
    "library/keiyaku.ts": [
      'import { reviewOperation } from "../protocol/review.js";',
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

  const typedTimeline = check({
    "akuma/heart/timeline.ts": [
      'import type { DatabaseSync } from "node:sqlite";',
      "export function read(database: DatabaseSync): void { void database; }",
    ].join("\n"),
  });
  assert.deepEqual(typedTimeline, []);

  const typedSoul = check({
    "akuma/heart/soul.ts": [
      'import type { DatabaseSync } from "node:sqlite";',
      "export function read(database: DatabaseSync): void { void database; }",
    ].join("\n"),
  });
  assert.deepEqual(typedSoul, []);

  const runtimeRows = check({
    "akuma/heart/rows.ts": 'import { DatabaseSync } from "node:sqlite"; export const database = new DatabaseSync(":memory:");',
  });
  assert.ok(rules(runtimeRows).includes("architecture/capability-import"));

  const runtimeSchema = check({
    "akuma/heart/schema.ts": 'import { DatabaseSync } from "node:sqlite"; export const database = new DatabaseSync(":memory:");',
  });
  assert.ok(rules(runtimeSchema).includes("architecture/capability-import"));

  const runtimeTimeline = check({
    "akuma/heart/timeline.ts": 'import { DatabaseSync } from "node:sqlite"; export const database = new DatabaseSync(":memory:");',
  });
  assert.ok(rules(runtimeTimeline).includes("architecture/capability-import"));

  const runtimeSoul = check({
    "akuma/heart/soul.ts": 'import { DatabaseSync } from "node:sqlite"; export const database = new DatabaseSync(":memory:");',
  });
  assert.ok(rules(runtimeSoul).includes("architecture/capability-import"));

  const statementInJudge = check({
    "akuma/heart/index.ts": 'export function judge(database: { prepare(sql: string): void }): void { database.prepare("SELECT 1"); }',
  });
  assert.equal(rules(statementInJudge).filter((rule) => rule === "architecture/forbidden-source-pattern").length, 2);
});

test("architecture policy gives provider recipe grammar one inward dependency direction", () => {
  const accepted = check({
    "akuma/provider-recipe.ts": "export type ProviderOptions = {};",
    "akuma/heart/facts.ts": 'import type { ProviderOptions } from "../provider-recipe.js"; export type SoulOptions = ProviderOptions;',
    "akuma/provider.ts": 'import type { ProviderOptions } from "./provider-recipe.js"; export type DriveOptions = ProviderOptions;',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "akuma/heart/facts.ts": "export type Soul = {};",
    "akuma/provider-recipe.ts": 'import type { Soul } from "./heart/facts.js"; export type Recipe = Soul;',
  });
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});

test("architecture policy gives activity codec directions exact runtime owners", () => {
  const provider = [
    "export function encodeAgentEvent(): void {}",
    "export function decodeAgentEvent(): void {}",
  ].join("\n");
  const accepted = check({
    "akuma/provider.ts": provider,
    "akuma/body-turn.ts": 'import { encodeAgentEvent } from "./provider.js"; export const encode = encodeAgentEvent;',
    "akuma/akuma.ts": 'import { decodeAgentEvent } from "./provider.js"; export const decode = decodeAgentEvent;',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "akuma/provider.ts": provider,
    "akuma/body-turn.ts": 'import { decodeAgentEvent } from "./provider.js"; export const decode = decodeAgentEvent;',
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
    "git/process.ts": "export type GitRepository = {};",
    "core/facts/fold.ts": 'import type { GitRepository } from "../../git/process.js"; export function fold(repository: GitRepository): void {}',
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps verbs away from admission and repository", () => {
  const diagnostics = check({
    "git/admission.ts": "export type Offer = {};",
    "git/process.ts": "export type GitRepository = {};",
    "core/verbs/deliver.ts": [
      'import type { Offer } from "../../git/admission.js";',
      'import type { GitRepository } from "../../git/process.js";',
      "export function decideDeliver(offer: Offer, repository: GitRepository): void {}",
    ].join("\n"),
  });
  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 2);
});

test("architecture policy permits protocol to join pact with Git", () => {
  const diagnostics = check({
    "core/decide.ts": "export type AttemptContext = {};",
    "git/process.ts": "export type GitRepository = {};",
    "git/observe.ts": 'import type { GitRepository } from "./process.js"; export function observeContractsForAdmissionAt(repository: GitRepository): void { void repository; }',
    "protocol/attempt.ts": "export function admitDecidedOffer(): void {}",
    "protocol/run.ts": 'import { observeContractsForAdmissionAt } from "../git/observe.js"; import type { GitRepository } from "../git/process.js"; import type { AttemptContext } from "../core/decide.js"; import { admitDecidedOffer } from "./attempt.js"; export function run(repository: GitRepository, attempt: AttemptContext): void { observeContractsForAdmissionAt(repository); void attempt; admitDecidedOffer(); }',
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

test("architecture policy lets Verification protocol own generic currentness lookup", () => {
  const accepted = check({
    "core/facts/gate.ts": "export function latestCurrentAttestations(): void {}",
    "verification/declaration.ts": "export const VERIFIED = 'verified';",
    "protocol/intent.ts": [
      'import { latestCurrentAttestations } from "../core/facts/gate.js";',
      'import { VERIFIED } from "../verification/declaration.js";',
      "export function current(): void { latestCurrentAttestations(); void VERIFIED; }",
    ].join("\n"),
  });
  assert.deepEqual(accepted, []);

  const rejectedLookup = check({
    "core/facts/gate.ts": "export function latestCurrentAttestations(): void {}",
    "protocol/operations.ts": 'import { latestCurrentAttestations } from "../core/facts/gate.js"; export function complete(): void { latestCurrentAttestations(); }',
  });
  assert.deepEqual(rules(rejectedLookup), ["architecture/dependency-direction"]);

  const rejectedVerified = check({
    "verification/declaration.ts": "export const VERIFIED = 'verified';",
    "protocol/operations.ts": 'import { VERIFIED } from "../verification/declaration.js"; export function complete(): void { void VERIFIED; }',
  });
  assert.deepEqual(rules(rejectedVerified), ["architecture/dependency-direction"]);

  const rejectedOtherGate = check({
    "core/facts/gate.ts": "export function gateReports(): void {}",
    "protocol/intent.ts": 'import { gateReports } from "../core/facts/gate.js"; export function verify(): void { gateReports(); }',
  });
  assert.deepEqual(rules(rejectedOtherGate), ["architecture/dependency-direction"]);
});

test("architecture policy gives public audit invocation one library owner", () => {
  const accepted = check({
    "protocol/audit.ts": "export function auditOperation(): void {} export type AuditReport = {};",
    "protocol/operations.ts": "export type RepositoryScope = {};",
    "library/input.ts": "export function requireInput(): void {} export function documentDerivation(): void {}",
    "library/mutation.ts": "export function completeMutation(): void {}",
    "library/refusal.ts": "export function requireAccepted(): void {}",
    "library/configuration.ts": "export function worktreeHooksOption(): void {}",
    "library/audit.ts": [
      'import { auditOperation } from "../protocol/audit.js";',
      'import { documentDerivation, requireInput } from "./input.js";',
      'import { completeMutation } from "./mutation.js";',
      'import { requireAccepted } from "./refusal.js";',
      'import { worktreeHooksOption } from "./configuration.js";',
      "export type AuditInput = {};",
      "export function auditContract(): void { requireInput(); worktreeHooksOption(); documentDerivation(); requireAccepted(); auditOperation(); completeMutation(); }",
    ].join("\n"),
    "library/contract.ts": 'import { auditContract, type AuditInput } from "./audit.js"; export type Input = AuditInput; export function audit(): void { auditContract(); }',
  });
  assert.deepEqual(accepted, []);

  const rejectedFacade = check({
    "protocol/audit.ts": "export function auditOperation(): void {}",
    "library/contract.ts": 'import { auditOperation } from "../protocol/audit.js"; export function audit(): void { auditOperation(); }',
  });
  assert.deepEqual(rules(rejectedFacade), ["architecture/dependency-direction"]);

  const rejectedGate = check({
    "core/facts/gate.ts": "export function latestCurrentAttestations(): void {}",
    "library/audit.ts": 'import { latestCurrentAttestations } from "../core/facts/gate.js"; export function audit(): void { latestCurrentAttestations(); }',
  });
  assert.deepEqual(rules(rejectedGate), ["architecture/dependency-direction"]);

  const rejectedObserver = check({
    "git/target-placement.ts": "export function observeTargetPlacement(): void {}",
    "library/audit.ts": 'import { observeTargetPlacement } from "../git/target-placement.js"; export function audit(): void { observeTargetPlacement(); }',
  });
  assert.deepEqual(rules(rejectedObserver), ["architecture/dependency-direction"]);
});

test("architecture policy lets audit operations call the Git target adjudicator", () => {
  const accepted = check({
    "git/target-placement.ts": "export function observeTargetPlacement(): void {} export function adjudicateAuditTarget(): void {} export type TargetPlacementRefusal = {};",
    "protocol/placement.ts": 'import { observeTargetPlacement } from "../git/target-placement.js"; export function observe(): void { observeTargetPlacement(); }',
    "protocol/audit.ts": [
      'import { adjudicateAuditTarget } from "../git/target-placement.js";',
      "export function audit(): void { adjudicateAuditTarget(); }",
    ].join("\n"),
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "git/target-placement.ts": "export function observeTargetPlacement(): void {}",
    "library/audit.ts": 'import { observeTargetPlacement } from "../git/target-placement.js"; export function audit(): void { observeTargetPlacement(); }',
  });
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});

test("architecture policy permits the aggregate status read path", () => {
  const diagnostics = check({
    "core/facts/types.ts": "export type ContractId = string; export type ContractState = {}; export type SnapshotId = string;",
    "core/facts/gate.ts": "export function gateReports(): void {} export function gatesSatisfied(): void {}",
    "git/workspace.ts": "export function worktreePath(): string { return \"\"; }",
    "protocol/read/status.ts": [
      'import { worktreePath } from "../../git/workspace.js";',
      'import { gateReports } from "../../core/facts/gate.js";',
      'import type { ContractId, ContractState, SnapshotId } from "../../core/facts/types.js";',
      "export type ContractRow = { id: ContractId; delivery: unknown; targetObservation: unknown };",
      "export type ContractBoard = { rows: readonly ContractRow[] };",
      "export function readContractBoard(state: ContractState): ContractBoard { void worktreePath; gateReports(); void state; return { rows: [] }; }",
    ].join("\n"),
    "protocol/operations.ts": [
      'import { readContractBoard, type ContractBoard, type ContractRow } from "./read/status.js";',
      "export function contracts(): ContractBoard { return readContractBoard({}); }",
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
    "git/repository.ts": "export const GIT_REF = ''; export async function readRef(): Promise<void> {}",
    "git/process.ts": "export type GitRepository = {};",
    "protocol/attempt.ts": 'import { GIT_REF, readRef } from "../git/repository.js"; import type { GitRepository } from "../git/process.js"; export async function classify(repository: GitRepository): Promise<void> { void GIT_REF; await readRef(); void repository; }',
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
    "kanshi/read.ts": "export function observedAt(): string { return new Date().toISOString(); }",
    "akuma/providers/acp/core.ts": "export const environment = globalThis.process.env;",
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

  for (const access of ["process.env", "globalThis.process.env"] as const) {
    const misplacedEnvironment = check({
      "core/facts/types.ts": `export const environment = ${access};`,
    });
    assert.ok(rules(misplacedEnvironment).includes("architecture/capability-use"));
  }
});

test("architecture policy enforces symbol-scoped allowances", () => {
  const diagnostics = check({
    "core/subject.ts": "export function parseDependencyKeySet(): void {} export function other(): void {}",
    "core/facts/codec.ts": 'import { other } from "../subject.js"; export function codec(): void { other(); }',
  });
  assert.ok(rules(diagnostics).includes("architecture/dependency-direction"));
});

test("architecture policy scopes type-only allowances to approved symbols", () => {
  const accepted = check({
    "git/process.ts": "export type GitRepository = {}; export type Other = {};",
    "workspace-place.ts": 'import type { GitRepository } from "./git/process.js"; export function place(repository: GitRepository): void { void repository; }',
  });
  assert.deepEqual(accepted, []);

  const rejected = check({
    "git/process.ts": "export type GitRepository = {}; export type Other = {};",
    "workspace-place.ts": 'import type { Other } from "./git/process.js"; export function place(value: Other): void { void value; }',
  });
  assert.ok(rules(rejected).includes("architecture/dependency-direction"));
});

test("architecture policy uses specific zone before catch-all for Contract front door", () => {
  const diagnostics = check({
    "protocol/review.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": 'import { reviewOperation } from "../protocol/review.js"; export function facade(): void { reviewOperation(); }',
  });
  assert.deepEqual(diagnostics, []);
});

test("architecture policy keeps Kanshi off Task persistence", () => {
  const diagnostics = check({
    "task/store.ts": "export function readBoard(): void {}",
    "kanshi/read.ts": 'import { readBoard } from "../task/store.js"; export function read(): void { readBoard(); }',
  });
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps shared Git observation product-blind and Kanshi composition-only", () => {
  const gitProductKnowledge = check({
    "git/read-observation.ts": "export const path = 'dispatch/item.json';",
  });
  assert.ok(rules(gitProductKnowledge).includes("architecture/forbidden-source-pattern"));

  const kanshiGitMechanics = check({
    "kanshi/read.ts": "export function read(observation: any): unknown { return observation.snapshot; }",
  });
  assert.ok(rules(kanshiGitMechanics).includes("architecture/forbidden-source-pattern"));

  const nominalChannel = check({
    "git/read-observation.ts": "class BatchReader { #child = null; }",
  });
  assert.ok(rules(nominalChannel).includes("architecture/forbidden-source-pattern"));

  const compatibilityChannel = check({
    "git/read-observation.ts": "export const read = () => withGitDecodeChannel(repo, (channel) => observeEpoch(repo, channel));",
  });
  assert.ok(rules(compatibilityChannel).includes("architecture/forbidden-source-pattern"));

  const mutatingAssertion = check({
    "git/repository.ts": "export const assertion = 'symref-update HEAD refs/heads/main';",
  });
  assert.ok(rules(mutatingAssertion).includes("architecture/forbidden-source-pattern"));
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
