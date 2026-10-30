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

type Edge = readonly [target: string, symbol: string, typeOnly?: boolean];

function graph(owner: string, edges: readonly Edge[], prefix = ""): readonly Diagnostic[] {
  const files: Record<string, string> = {};
  const source = [prefix];
  for (const [index, [target, symbol, typeOnly]] of edges.entries()) {
    files[target] =
      (files[target] ?? "") + (typeOnly ? `export type ${symbol} = {};\n` : `export function ${symbol}(): void {}\n`);
    let relative = path.posix.relative(path.posix.dirname(owner), target).replace(/\.ts$/u, ".js");
    if (!relative.startsWith(".")) relative = `./${relative}`;
    source.push(`import ${typeOnly ? "type " : ""}{ ${symbol} as edge${index} } from ${JSON.stringify(relative)};`);
    source.push(typeOnly ? `export type Value${index} = edge${index};` : `export const value${index} = edge${index};`);
  }
  files[owner] = source.join("\n");
  return check(files);
}

const directionCases: readonly (readonly [owner: string, edge: Edge, allowed: boolean])[] = [
  ["git/repository.ts", ["git/owner-state.ts", "readOwnerState"], true],
  ["git/repository.ts", ["git/internal/owner-state.ts", "readOwnerState"], true],
  ["library/selection.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], true],
  ["library/selection.ts", ["plugin/akuma-signals.ts", "withAkumaWaitDeferrals"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "emitPluginSignal"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "withAkumaWaitDeferrals"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "stderrPluginDiagnostic"], true],
  ["library/selection.ts", ["plugin/akuma-signals.ts", "stderrPluginDiagnostic"], true],
  ["library/akumas.ts", ["akuma/akuma-instance.ts", "captureAkumaHostDiagnostic"], true],
  ["library/akumas.ts", ["akuma/akuma-instance.ts", "AkumaHostOptions", true], true],
  ["library/akuma-retention.ts", ["akuma/retention.ts", "retireInactiveAkuma"], true],
  ["akuma/retention.ts", ["git/observe.ts", "observeContractAt"], false],
  ["akuma/selection-owner-port.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], true],
  ["akuma/akuma-observe.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], false],
  ["akuma/body.ts", ["plugin/akuma-signals.ts", "emitPluginSignal"], true],
  ["akuma/body.ts", ["plugin/akuma-signals.ts", "pluginRuntime"], false],
  ["akuma/body.ts", ["akuma/body-launch.ts", "observeBodyLaunch"], true],
  ["akuma/body.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/body-launch.ts", ["runtime/proc/run.ts", "DetachedProcessExit", true], false],
  ["akuma/publication.ts", ["akuma/body-launch.ts", "LiveBodyLaunch", true], true],
  ["akuma/publication.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/call-request.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/turn-drive.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/detached-body.ts", ["runtime/proc/run.ts", "spawnDetachedProcess"], true],
  ["akuma/in-process-body.ts", ["akuma/body.ts", "driveAkumaBody"], true],
  ["akuma/in-process-body.ts", ["runtime/proc/run.ts", "spawnDetachedProcess"], false],
  ["akuma/akuma-instance.ts", ["body-host.ts", "captureAkumaHost"], true],
  ["library/akumas.ts", ["body-host.ts", "captureAkumaHost"], true],
  ["index.ts", ["body-host.ts", "AkumaHost"], true],
  ["index.ts", ["body-host.ts", "AkumaHostScope", true], true],
  ["index.ts", ["body-host.ts", "captureAkumaHost"], false],
  ["body-host.ts", ["body-requests.ts", "externalRequestCommandsFor"], true],
  ["body-requests.ts", ["library/contract-composition.ts", "composeContractLibrary"], true],
  ["akuma/akuma-instance.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], true],
  ["akuma-body.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], true],
  ["library/akumas.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], true],
  ["library/selection.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], false],
  ["library/akuma-creation.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], false],
  ["cli/commands/contract.ts", ["core/verbs/bind.ts", "decideBind"], false],
  ["library/delivery-preview.ts", ["git/target-placement.ts", "observeTargetPlacement"], false],
  ["protocol/delivery-preview.ts", ["protocol/intent.ts", "currentVerifiedAttestation"], true],
  ["protocol/delivery-preview.ts", ["protocol/intent.ts", "verifyDelivery"], false],
  ["protocol/delivery-preview.ts", ["protocol/deliver.ts", "prepareDelivery"], true],
  ["protocol/delivery-preview.ts", ["protocol/deliver.ts", "admitDeliveryOperation"], false],
  ["protocol/delivery-preview.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["protocol/delivery-preview.ts", ["verification/execution.ts", "runVerification"], false],
  ["core/facts/fold.ts", ["git/repository.ts", "repositoryAt"], false],
  ["library/contract.ts", ["git/repository.ts", "repositoryAt"], false],
  ["library/contract.ts", ["protocol/attempt.ts", "admitDecidedOffer"], false],
  ["library/contract.ts", ["protocol/review.ts", "reviewOperation"], true],
  ["library/contract-address.ts", ["protocol/operations.ts", "contractsOperation"], true],
  ["library/contract-address.ts", ["cli/selectors.ts", "resolveContractId"], false],
  ["library/address.ts", ["library/contract-address.ts", "matchContractCandidates"], true],
  ["kanshi/read.ts", ["git/read-observation.ts", "withGitReadObservation"], true],
  ["kanshi/read.ts", ["body/decode.ts", "decodeContractDocument"], true],
  ["kanshi/read.ts", ["body/region.ts", "assertRegionPattern"], true],
  ["kanshi/report.ts", ["library/region.ts", "RegionOverlap", true], true],
  ["kanshi/select.ts", ["body/region.ts", "assertRegionPattern"], true],
  ["kanshi/read.ts", ["git/read-observation.ts", "withGitTargetedReadObservation"], false],
  ["kanshi/read.ts", ["library/region.ts", "regionOverlaps"], false],
  ["kanshi/select.ts", ["library/region.ts", "regionOverlaps"], false],
  ["index.ts", ["kanshi/index.ts", "kanshiCategory"], true],
  ["cli/commands/contract.ts", ["index.ts", "kanshiCategory"], true],
  ["library/contract-operations.ts", ["protocol/attempt.ts", "admitDecidedOffer"], false],
  ["library/contract-operations.ts", ["protocol/placement.ts", "place"], false],
  ["library/contract-operations.ts", ["protocol/delivery-preview.ts", "decodeDeliveryPreviewReport"], false],
  ["library/contract-operations.ts", ["protocol/delivery-preview.ts", "deliveryPreviewReportSchema"], true],
  ["library/contract/moved-owner.ts", ["library/akuma-creation.ts", "createAkuma"], false],
  ["library/contract/moved-owner.ts", ["library/bind.ts", "bind"], false],
  ["library/contract/moved-owner.ts", ["protocol/delivery-preview.ts", "previewDeliveryOperation"], false],
  ["akuma/heart/soul.ts", ["akuma/caller.ts", "decodeAkumaCaller"], true],
  ["akuma/heart/facts.ts", ["akuma/caller.ts", "AkumaCaller", true], true],
  ["akuma/providers/example/adapter.ts", ["akuma/heart/index.ts", "Heart", true], true],
  ["akuma/providers/example/adapter.ts", ["akuma/heart/index.ts", "writeFact"], false],
  ["protocol/operations.ts", ["git/target-placement.ts", "TargetPlacementRefusal", true], true],
  ["protocol/operations.ts", ["git/target-placement.ts", "checkoutNotFollowableRefusalSchema"], true],
  ["protocol/operations.ts", ["git/target-placement.ts", "prepareTargetPlacement"], false],
  ["library/outcome.ts", ["settlement/settle.ts", "settlementLagSchema"], true],
  ["library/outcome.ts", ["settlement/settle.ts", "settleContract"], false],
  ["library/outcome.ts", ["protocol/completion.ts", "completionEvidenceSchema"], true],
  ["library/outcome.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["protocol/run.ts", ["git/target-placement.ts", "prepareTargetPlacement"], false],
  ["akuma/akuma.ts", ["library/contract.ts", "contract"], false],
  ["akuma/akuma.ts", ["library/contract.ts", "Contract", true], false],
  ["library/keiyaku.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["library/contract-execution.ts", ["protocol/completion.ts", "completeCandidate"], true],
  ["library/contract-creation.ts", ["library/bind.ts", "prepareMarkdownBind"], true],
  ["library/invocation.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["library/invocation.ts", ["protocol/progress.ts", "ProtocolProgress", true], true],
  ["body-requests.ts", ["dispatch/index.ts", "readDispatch"], true],
  ["body-requests.ts", ["git/repository.ts", "repositoryAt"], true],
  ["akuma/akuma-owner.ts", ["dispatch/index.ts", "readDispatch"], false],
  ["akuma/akuma-wait.ts", ["alias/index.ts", "readAliases"], false],
  ["akuma/akuma-call.ts", ["library/akuma-creation.ts", "callAkumas"], false],
  ["akuma/akuma-selection-execution.ts", ["debt/index.ts", "Debts"], false],
  ["protocol/intent.ts", ["core/facts/gate.ts", "latestCurrentAttestations"], true],
  ["protocol/intent.ts", ["verification/declaration.ts", "VERIFIED"], true],
  ["protocol/intent.ts", ["core/facts/gate.ts", "gateReports"], false],
];
for (const [owner, edge, allowed] of directionCases) {
  test(`owner edge ${owner} -> ${edge[0]}:${edge[1]} (${edge[2] ? "type" : "value"})`, () => {
    assert.deepEqual(rules(graph(owner, [edge])), allowed ? [] : ["architecture/dependency-direction"]);
  });
}

for (const owner of [
  "body",
  "body-launch",
  "publication",
  "call-request",
  "turn-drive",
  "akuma-owner",
  "akuma-call",
  "akuma-selection-execution",
  "selection-owner-port",
]) {
  test(`${owner} consumes neutral launch capabilities, never concrete hosting`, () => {
    assert.deepEqual(graph(`akuma/${owner}.ts`, [["akuma/body-launch.ts", "BodyLauncher", true]]), []);
    for (const edge of [
      ["akuma/detached-body.ts", "spawnAkumaBody"],
      ["akuma/akuma-instance.ts", "Akuma"],
      ["runtime/proc/run.ts", "spawnDetachedProcess"],
    ] as const) {
      assert.deepEqual(rules(graph(`akuma/${owner}.ts`, [edge])), ["architecture/dependency-direction"]);
    }
  });
}

for (const verb of ["review", "deliver"]) {
  test(`${verb} admits completion types, never completion effects`, () => {
    assert.deepEqual(graph(`protocol/${verb}.ts`, [["protocol/completion.ts", "CompletionEvidence", true]]), []);
    for (const node of ["completion", "placement", "reintegrate"]) {
      assert.deepEqual(rules(graph(`protocol/${verb}.ts`, [[`protocol/${node}.ts`, "advance"]])), [
        "architecture/dependency-direction",
      ]);
    }
  });
}
for (const owner of ["contract-execution", "continuation"]) {
  test(`${owner} calls completion, never raw admission`, () => {
    assert.deepEqual(graph(`library/${owner}.ts`, [["protocol/completion.ts", "completeCandidate"]]), []);
    for (const low of ["attempt", "placement", "run"]) {
      assert.deepEqual(rules(graph(`library/${owner}.ts`, [[`protocol/${low}.ts`, "raw"]])), [
        "architecture/dependency-direction",
      ]);
    }
  });
}

const marker = "/** @architectureCompositionRoot */";
const akuma: Edge = ["akuma/akuma.ts", "runtime"];
const debts: Edge = ["debt/index.ts", "debts"];
const catalog: Edge = ["debt/catalog.ts", "catalog"];
const compositionCases: readonly (readonly [string, readonly Edge[], string, boolean])[] = [
  [
    "library/keiyaku.ts",
    [
      ["akuma/requests.ts", "executionChannel"],
      ["library/contract.ts", "contract"],
    ],
    marker,
    true,
  ],
  ["library/akumas.ts", [akuma, debts], marker, true],
  ["library/akumas/index.ts", [akuma, catalog], marker, true],
  [
    "library/selection.js",
    [akuma, ["dispatch/index.ts", "observeDispatch"], ["debt/created-observation.ts", "observeCreatedDebt"]],
    marker,
    true,
  ],
  ["library/moved-root.ts", [akuma, debts], marker, true],
  ["library/akumas.ts", [akuma, debts], "", false],
  ["library/rogue-composition.ts", [akuma, debts], "", false],
  ["library/rogue.ts", [akuma, debts, ["workspace-place.ts", "appoint"]], "", false],
  ["library/selection-extra.ts", [akuma, debts], "", false],
  [
    "library/nested-marker.ts",
    [akuma, debts],
    `export const architectureCompositionRoot = true;\n${marker}\nexport function nested(): void {}`,
    false,
  ],
];
for (const [owner, edges, prefix, allowed] of compositionCases) {
  test(`composition boundary ${owner} (${allowed ? "marked" : "unmarked"})`, () => {
    assert.deepEqual(rules(graph(owner, edges, prefix)), allowed ? [] : ["architecture/composition-boundary"]);
  });
}

for (const [owner, module, symbol, rule] of [
  ["runtime/proc/run.ts", "node:child_process", "spawn", ""],
  ["scripts/compile-tests.mjs", "node:module", "stripTypeScriptTypes", ""],
  ["scripts/compile-tests.mjs", "node:module", "createRequire", "capability-import"],
  ["core/verbs/bind.ts", "node:child_process", "spawn", "capability-import"],
  ["core/verbs/bind.ts", "node:fs", "readFileSync", "capability-import"],
  ["core/verbs/bind.ts", "zod", "z", "capability-import"],
  ["akuma/providers/opencode-sdk/client.ts", "@opencode-ai/sdk", "client", ""],
  ["protocol/attempt.ts", "@opencode-ai/sdk", "client", "provider-sdk-boundary"],
]) {
  test(`capability ${owner} imports ${module}`, () => {
    const found = check({
      [owner!]: `import { ${symbol} } from ${JSON.stringify(module)}; ${owner === "core/verbs/bind.ts" ? `export function decideBind(): void { void ${symbol}; }` : `export const value = ${symbol};`}`,
    });
    assert.deepEqual(rules(found), rule ? [`architecture/${rule}`] : []);
  });
}
for (const [owner, allowed] of [
  ["protocol/intent.ts", false],
  ["verification/execution.ts", true],
  ["core/facts/state.ts", false],
] as const) {
  test(`ambient environment in ${owner}`, () => {
    assert.deepEqual(
      rules(check({ [owner]: "export const environment = process.env;" })),
      allowed ? [] : ["architecture/capability-use"],
    );
  });
}

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
