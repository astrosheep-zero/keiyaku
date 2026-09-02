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

test("architecture policy accepts internal owner topology changes", () => {
  const renamed = check({
    "git/repository.ts": 'import { readOwnerState } from "./owner-state.js"; export const read = readOwnerState;',
    "git/owner-state.ts": "export const readOwnerState = 1;",
  });
  const moved = check({
    "git/repository.ts":
      'import { readOwnerState } from "./internal/owner-state.js"; export const read = readOwnerState;',
    "git/internal/owner-state.ts": "export const readOwnerState = 1;",
  });

  assert.deepEqual(renamed, []);
  assert.deepEqual(moved, []);
});

test("architecture policy permits Body's turn-outcome plugin runtime delivery", () => {
  const diagnostics = check({
    "plugin/runtime.ts":
      "export type PluginRuntime = {}; export function pluginRuntime(): PluginRuntime { return {}; }",
    "akuma/body.ts": [
      'import { pluginRuntime, type PluginRuntime } from "../plugin/runtime.js";',
      "export const runtime: PluginRuntime = pluginRuntime();",
    ].join("\n"),
  });

  assert.deepEqual(diagnostics, []);
});

test("architecture policy rejects reverse owner edges", () => {
  const diagnostics = check({
    "core/facts/types.ts": "export type ContractId = string;",
    "core/verbs/bind.ts": "export function decideBind(): void {}",
    "git/repository.ts": "export function repositoryAt(): void {}",
    "git/target-placement.ts": "export function observeTargetPlacement(): void {}",
    "cli/commands/bind.ts": 'import { decideBind } from "../../core/verbs/bind.js"; export const bind = decideBind;',
    "library/audit.ts":
      'import { observeTargetPlacement } from "../git/target-placement.js"; export const audit = observeTargetPlacement;',
    "core/facts/fold.ts": 'import { repositoryAt } from "../../git/repository.js"; export const fold = repositoryAt;',
  });

  assert.equal(rules(diagnostics).filter((rule) => rule === "architecture/dependency-direction").length, 3);
});

test("architecture policy keeps the Contract handle on its public neighbors", () => {
  const diagnostics = check({
    "git/repository.ts": "export function repositoryAt(): void {}",
    "protocol/attempt.ts": "export function admitDecidedOffer(): void {}",
    "protocol/review.ts": "export function reviewOperation(): void {}",
    "library/contract.ts": [
      'import { repositoryAt } from "../git/repository.js";',
      'import { admitDecidedOffer } from "../protocol/attempt.js";',
      'import { reviewOperation } from "../protocol/review.js";',
      "export const facade = [repositoryAt, admitDecidedOffer, reviewOperation];",
    ].join("\n"),
  });

  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction", "architecture/dependency-direction"]);
});

test("architecture policy keeps Kanshi on public-owner composition", () => {
  const accepted = check({
    "git/read-observation.ts": "export function withGitReadObservation(): void {}",
    "kanshi/read.ts":
      'import { withGitReadObservation } from "../git/read-observation.js"; export const read = withGitReadObservation;',
  });
  const rejected = check({
    "git/read-observation.ts": "export function withGitTargetedReadObservation(): void {}",
    "kanshi/read.ts":
      'import { withGitTargetedReadObservation } from "../git/read-observation.js"; export const read = withGitTargetedReadObservation;',
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});

test("architecture policy keeps Contract edges forbidden after a move", () => {
  const diagnostics = check({
    "library/akuma-creation.ts": "export function createAkuma(): void {}",
    "library/bind.ts": "export function bind(): void {}",
    "protocol/audit.ts": "export function auditOperation(): void {}",
    "library/contract/moved-owner.ts": [
      'import { createAkuma } from "../akuma-creation.js";',
      'import { bind } from "../bind.js";',
      'import { auditOperation } from "../../protocol/audit.js";',
      "export const contract = [createAkuma, bind, auditOperation];",
    ].join("\n"),
  });

  assert.deepEqual(rules(diagnostics), Array(3).fill("architecture/dependency-direction"));
});

test("architecture policy keeps provider adapters out of Heart writes", () => {
  const accepted = check({
    "akuma/heart/index.ts": "export type Heart = {};",
    "akuma/providers/example/adapter.ts":
      'import type { Heart } from "../../heart/index.js"; export type Adapter = Heart;',
  });
  const rejected = check({
    "akuma/heart/index.ts": "export function writeFact(): void {}",
    "akuma/providers/example/adapter.ts":
      'import { writeFact } from "../../heart/index.js"; export const adapter = writeFact;',
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});

test("architecture policy assigns process and filesystem capabilities to their owners", () => {
  const accepted = check({
    "runtime/proc/run.ts": 'import { spawn } from "node:child_process"; export const run = spawn;',
  });
  const rejected = check({
    "core/verbs/bind.ts": [
      'import { spawn } from "node:child_process";',
      'import { readFileSync } from "node:fs";',
      "export function decideBind(): void { void spawn; void readFileSync; }",
    ].join("\n"),
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), ["architecture/capability-import", "architecture/capability-import"]);
});

test("architecture policy keeps ambient process environments out of protocol", () => {
  const diagnostics = check({
    "protocol/intent.ts": "export const environment = process.env;",
  });

  assert.ok(rules(diagnostics).includes("architecture/capability-use"));
});

test("architecture policy keeps generic Protocol runtime away from target placement", () => {
  const accepted = check({
    "git/target-placement.ts": "export type TargetPlacementRefusal = { kind: string };",
    "protocol/operations.ts":
      'import type { TargetPlacementRefusal } from "../git/target-placement.js"; export type Refusal = TargetPlacementRefusal;',
  });
  const diagnostics = check({
    "git/target-placement.ts": "export function prepareTargetPlacement(): void {}",
    "protocol/run.ts":
      'import { prepareTargetPlacement } from "../git/target-placement.js"; export const run = prepareTargetPlacement;',
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps Akuma runtime away from generic Library", () => {
  const diagnostics = check({
    "library/contract.ts": "export function contract(): void {}",
    "akuma/akuma.ts": 'import { contract } from "../library/contract.js"; export const runtime = contract;',
  });

  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps denied Akuma Library edges closed for type imports", () => {
  const diagnostics = check({
    "library/contract.ts": "export type Contract = string;",
    "akuma/akuma.ts": 'import type { Contract } from "../library/contract.js"; export type RuntimeContract = Contract;',
  });

  assert.deepEqual(rules(diagnostics), ["architecture/dependency-direction"]);
});

test("architecture policy keeps cross-product wiring in the named Library composition root", () => {
  const accepted = check({
    "akuma/requests.ts": "export function executionChannel(): void {}",
    "library/contract.ts": "export function contract(): void {}",
    "library/composition.ts": [
      'import { executionChannel } from "../akuma/requests.js";',
      'import { contract } from "./contract.js";',
      "export const compose = [executionChannel, contract];",
    ].join("\n"),
  });
  const knownComposition = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/catalog.ts": "export function catalog(): void {}",
    "library/catalog.ts": [
      'import { runtime } from "../akuma/akuma.js";',
      'import { catalog } from "../task/catalog.js";',
      "export const list = [runtime, catalog];",
    ].join("\n"),
  });

  const diagnostics = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/index.ts": "export function tasks(): void {}",
    "library/rogue-composition.ts": [
      'import { runtime } from "../akuma/akuma.js";',
      'import { tasks } from "../task/index.js";',
      "export const compose = [runtime, tasks];",
    ].join("\n"),
  });
  const ordinaryDiagnostics = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/index.ts": "export function tasks(): void {}",
    "workspace-place.ts": "export function appoint(): void {}",
    "library/rogue.ts": [
      'import { runtime } from "../akuma/akuma.js";',
      'import { tasks } from "../task/index.js";',
      'import { appoint } from "../workspace-place.js";',
      "export const compose = [runtime, tasks, appoint];",
    ].join("\n"),
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(knownComposition, []);
  assert.deepEqual(rules(diagnostics), ["architecture/composition-boundary"]);
  assert.deepEqual(rules(ordinaryDiagnostics), ["architecture/composition-boundary"]);
});

test("architecture policy keeps provider SDKs inside their adapter owners", () => {
  const accepted = check({
    "akuma/providers/opencode-sdk/client.ts":
      'import { client } from "@opencode-ai/sdk"; export const adapter = client;',
  });
  const rejected = check({
    "protocol/attempt.ts": 'import { client } from "@opencode-ai/sdk"; export const attempt = client;',
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), ["architecture/provider-sdk-boundary"]);
});

test("architecture policy keeps runtime cycles and undeclared source visible", () => {
  const diagnostics = check({
    "cli/parse.ts": 'import { contract } from "../library/contract.js"; export const parse = contract;',
    "library/contract.ts": 'import { parse } from "../cli/parse.js"; export const contract = parse;',
    "unowned/model.ts": "export type Model = string;",
  });

  assert.ok(rules(diagnostics).includes("architecture/dependency-cycle"));
  assert.ok(rules(diagnostics).includes("architecture/unowned-source"));
});

test("architecture policy keeps durable source and model refusals", () => {
  const diagnostics = check({
    "akuma/heart/index.ts": 'export const sql = "SELECT * FROM heart";',
    "cli/actor.ts": 'import Database from "better-sqlite3"; export const actor = Database;',
    "core/verbs/bind.ts": "export type OpenData = {}; export function decideBind(): void {}",
    "git/read-observation.ts": 'export const path = "dispatch/item.json";',
  });
  const found = new Set(rules(diagnostics));

  assert.ok(found.has("architecture/forbidden-source-pattern"));
  assert.ok(found.has("architecture/forbidden-module"));
  assert.ok(found.has("architecture/removed-declaration"));
});

test("architecture policy reserves Verification currentness for its protocol owner", () => {
  const accepted = check({
    "core/facts/gate.ts": "export function latestCurrentAttestations(): void {}",
    "verification/declaration.ts": 'export const VERIFIED = "verified";',
    "protocol/intent.ts": [
      'import { latestCurrentAttestations } from "../core/facts/gate.js";',
      'import { VERIFIED } from "../verification/declaration.js";',
      "export function current(): void { latestCurrentAttestations(); void VERIFIED; }",
    ].join("\n"),
  });
  const rejected = check({
    "core/facts/gate.ts": "export function gateReports(): void {}",
    "protocol/intent.ts": 'import { gateReports } from "../core/facts/gate.js"; export const current = gateReports;',
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), ["architecture/dependency-direction"]);
});
