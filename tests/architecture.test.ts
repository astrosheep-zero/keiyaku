import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkArchitecture, type Diagnostic, type SourceInput } from "../scripts/architecture/engine.js";
import { KEIYAKU_ARCHITECTURE_POLICY } from "../scripts/architecture/policy.js";
import { ARCHITECTURE_SOURCE_EXTENSION, runArchitectureCheck } from "../scripts/check-architecture.js";

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

test("architecture policy accepts Verification process-environment use and rejects unrelated owners", () => {
  const accepted = check({
    "verification/execution.ts": "export const environment = process.env;",
  });
  const rejected = check({
    "core/facts/state.ts": "export const environment = process.env;",
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), ["architecture/capability-use"]);
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

test("architecture policy keeps cross-product wiring in marked Library composition roots", () => {
  const compositionRoot = check({
    "akuma/requests.ts": "export function executionChannel(): void {}",
    "library/contract.ts": "export function contract(): void {}",
    "library/composition.ts": [
      "/** @architectureCompositionRoot */",
      'import { executionChannel } from "../akuma/requests.js";',
      'import { contract } from "./contract.js";',
      "export const compose = [executionChannel, contract];",
    ].join("\n"),
  });
  const catalogRoot = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/catalog.ts": "export function catalog(): void {}",
    "library/catalog.ts": [
      "/** @architectureCompositionRoot */",
      'import { runtime } from "../akuma/akuma.js";',
      'import { catalog } from "../task/catalog.js";',
      "export const list = [runtime, catalog];",
    ].join("\n"),
  });
  const movedCatalogRoot = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/catalog.ts": "export function catalog(): void {}",
    "library/catalog/index.ts": [
      "/** @architectureCompositionRoot */",
      'import { runtime } from "../../akuma/akuma.js";',
      'import { catalog } from "../../task/catalog.js";',
      "export const list = [runtime, catalog];",
    ].join("\n"),
  });
  const renamedFleetRoot = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "dispatch/index.ts": "export function observeDispatch(): void {}",
    "task/created-observation.ts": "export function observeCreatedTask(): void {}",
    "library/fleet.js": [
      "/** @architectureCompositionRoot */",
      'import { runtime } from "../akuma/akuma.js";',
      'import { observeDispatch } from "../dispatch/index.js";',
      'import { observeCreatedTask } from "../task/created-observation.js";',
      "export const fleet = [runtime, observeDispatch, observeCreatedTask];",
    ].join("\n"),
  });
  const relocatedMarkedRoot = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/index.ts": "export function tasks(): void {}",
    "library/moved-root.ts": [
      "/** @architectureCompositionRoot */",
      'import { runtime } from "../akuma/akuma.js";',
      'import { tasks } from "../task/index.js";',
      "export const compose = [runtime, tasks];",
    ].join("\n"),
  });

  const unmarkedHistoricalPath = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/catalog.ts": "export function catalog(): void {}",
    "library/catalog.ts": [
      'import { runtime } from "../akuma/akuma.js";',
      'import { catalog } from "../task/catalog.js";',
      "export const list = [runtime, catalog];",
    ].join("\n"),
  });
  const unregisteredComposition = check({
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
  const rootPrefixEscape = check({
    "akuma/akuma.ts": "export function runtime(): void {}",
    "task/index.ts": "export function tasks(): void {}",
    "library/fleet-extra.ts": [
      'import { runtime } from "../akuma/akuma.js";',
      'import { tasks } from "../task/index.js";',
      "export const compose = [runtime, tasks];",
    ].join("\n"),
  });

  assert.deepEqual(compositionRoot, []);
  assert.deepEqual(catalogRoot, []);
  assert.deepEqual(movedCatalogRoot, []);
  assert.deepEqual(renamedFleetRoot, []);
  assert.deepEqual(relocatedMarkedRoot, []);
  assert.deepEqual(rules(unmarkedHistoricalPath), ["architecture/composition-boundary"]);
  assert.deepEqual(rules(unregisteredComposition), ["architecture/composition-boundary"]);
  assert.deepEqual(rules(ordinaryDiagnostics), ["architecture/composition-boundary"]);
  assert.deepEqual(rules(rootPrefixEscape), ["architecture/composition-boundary"]);
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

test("architecture analysis covers executable JS, MJS, and CJS capability uses", () => {
  const spawn = 'import { spawn } from "node:child_process"; export const run = spawn;';
  const accepted = check({
    "scripts/owned.js": spawn,
    "scripts/owned.mjs": spawn,
    "scripts/owned.cjs": spawn,
    "runtime/proc/run.js": spawn,
  });
  const rejected = check({
    "core/verbs/bind.js": spawn,
    "core/verbs/bind.mjs": 'import { readFileSync } from "node:fs"; export const read = readFileSync;',
    "core/verbs/bind.cjs": "export const environment = process.env;",
  });

  assert.deepEqual(accepted, []);
  assert.deepEqual(rules(rejected), [
    "architecture/capability-use",
    "architecture/capability-import",
    "architecture/capability-import",
  ]);
});

test("architecture analysis detects top-level const container mutation without alias analysis", () => {
  const rejected = check({
    "core/facts/state.ts": [
      "const map = new Map();",
      "const set = new Set();",
      "const list = [];",
      "const record = {};",
      "map.set(1, 2);",
      "set.add(1);",
      "list.push(1);",
      "record.flag = true;",
    ].join("\n"),
  });
  const beforeDeclaration = check({
    "core/facts/state.ts": [
      "function mutate(): void { map.set(1, 2); list.push(1); record.flag = true; set.add(1); }",
      "const map = new Map();",
      "const set = new Set();",
      "const list = [];",
      "const record = {};",
    ].join("\n"),
    "core/facts/state.js": [
      "function mutate() { map.set(1, 2); list.push(1); }",
      "const map = new Map();",
      "const list = [];",
    ].join("\n"),
  });
  const accepted = check({
    "core/facts/state.ts": [
      "const count = 1;",
      "const nested = { items: [] };",
      "export function local(): void {",
      "  const map = new Map();",
      "  map.set(1, 2);",
      "  const list = [];",
      "  list.push(1);",
      "}",
      "nested.items.push(1);",
    ].join("\n"),
  });

  assert.equal(rules(rejected).filter((rule) => rule === "architecture/capability-use").length, 4);
  assert.ok(rejected.every((diagnostic) => diagnostic.detail.includes("module-mutable-state")));
  assert.equal(rules(beforeDeclaration).filter((rule) => rule === "architecture/capability-use").length, 6);
  assert.ok(beforeDeclaration.every((diagnostic) => diagnostic.detail.includes("module-mutable-state")));
  assert.deepEqual(accepted, []);
});

test("architecture policy owns plugin runtime module mutable state exactly", () => {
  const accepted = check({
    "plugin/runtime.ts": "const PROCESS_RUNTIMES = new Map();\nPROCESS_RUNTIMES.set(1, 2);\n",
  });
  const rejected = check({
    "core/facts/state.ts": "const map = new Map();\nmap.set(1, 2);\n",
    "core/facts/state.js": "const list = [];\nlist.push(1);\n",
    "core/facts/state.mjs": "const set = new Set();\nset.add(1);\n",
    "core/facts/state.cjs": "const record = {};\nrecord.flag = true;\n",
  });

  assert.deepEqual(accepted, []);
  assert.equal(rules(rejected).filter((rule) => rule === "architecture/capability-use").length, 4);
  assert.ok(rejected.every((diagnostic) => diagnostic.detail.includes("module-mutable-state")));
});

test("architecture source discovery includes executable JS, MJS, and CJS scripts", () => {
  assert.match("owned.js", ARCHITECTURE_SOURCE_EXTENSION);
  assert.match("owned.mjs", ARCHITECTURE_SOURCE_EXTENSION);
  assert.match("owned.cjs", ARCHITECTURE_SOURCE_EXTENSION);
  assert.doesNotMatch("owned.json", ARCHITECTURE_SOURCE_EXTENSION);

  const root = mkdtempSync(path.join(tmpdir(), "keiyaku-architecture-"));
  try {
    mkdirSync(path.join(root, "src", "core", "verbs"), { recursive: true });
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "src", "core", "verbs", "bind.ts"), "export function decideBind(): void {}");
    writeFileSync(
      path.join(root, "scripts", "owned.mjs"),
      'import { spawn } from "node:child_process"; export const run = spawn;\n',
    );
    writeFileSync(
      path.join(root, "src", "core", "verbs", "bind.js"),
      'import { spawn } from "node:child_process"; export const run = spawn;\n',
    );
    assert.equal(runArchitectureCheck(root), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
