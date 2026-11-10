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
  ["index.ts", ["akuma/akuma.ts", "akumaListRowSchema"], false],
  ["index.ts", ["akuma/akuma.ts", "akumaListSchema"], true],
  ["index.ts", ["akuma/projection.ts", "activityHistorySchema"], true],
  ["index.ts", ["akuma/caller.ts", "akumaCallerSchema"], true],
  ["index.ts", ["akuma/heart/facts.ts", "killEvidenceSchema"], true],
  ["index.ts", ["akuma/call-initial-tell.ts", "tellResultSchema"], false],
  ["index.ts", ["akuma/selection-observation.ts", "akumaWaitItemSchema"], true],
  ["index.ts", ["akuma/selection-observation.ts", "compactTellResult"], false],
  ["index.ts", ["library/akuma-creation.ts", "spawnObservationSchema"], false],
  ["index.ts", ["akuma/akuma-instance.ts", "akumaIdleResultSchema"], true],
  ["index.ts", ["akuma/akuma-selection-execution.ts", "liveStatusObservationSchema"], true],
  ["index.ts", ["akuma/akuma-selection-execution.ts", "askProgressSchema"], true],
  ["index.ts", ["akuma/akuma-selection-execution.ts", "AskProgress", true], true],
  ["index.ts", ["akuma/archetype.ts", "archetypeCatalogSchema"], true],
  ["index.ts", ["akuma/selection-observation.ts", "akumaObservationSchema"], true],
  ["index.ts", ["library/selection.ts", "akumaHistoryResultSchema"], true],
  ["index.ts", ["library/akuma-creation.ts", "spawnResultSchema"], true],
  ["index.ts", ["library/akuma-creation.ts", "spawnProgressSchema"], true],
  ["index.ts", ["library/akuma-creation.ts", "SpawnProgress", true], true],
  ["index.ts", ["library/keiyaku-identity.ts", "whoamiFactsSchema"], true],
  ["index.ts", ["library/keiyaku-identity.ts", "WhoamiFacts", true], true],
  ["index.ts", ["dispatch/index.ts", "dispatchSchema"], true],
  ["index.ts", ["library/keiyaku.ts", "Keiyaku"], true],
  ["index.ts", ["library/keiyaku-verbs.ts", "classifyVerb"], true],
  ["index.ts", ["library/keiyaku-verbs.ts", "VerbInput", true], true],
  ["index.ts", ["library/keiyaku-verbs.ts", "verbs"], false],
  ["library/keiyaku.ts", ["library/akuma-creation.ts", "SpawnProgress", true], true],
  ["library/keiyaku-classify.ts", ["library/akuma-creation.ts", "SpawnResult", true], true],
  ["library/keiyaku-classify.ts", ["library/akuma-creation.ts", "callAkumas"], false],
  ["library/keiyaku-verbs.ts", ["library/akuma-creation.ts", "spawnResultSchema"], true],
  ["library/keiyaku-verbs.ts", ["library/akuma-creation.ts", "callAkumas"], false],
  ["library/keiyaku-verbs.ts", ["protocol/execution-observation.ts", "executionObservationSchema"], true],
  ["library/keiyaku-verbs.ts", ["protocol/execution-observation.ts", "execute"], false],
  ["cli/commands/contract.ts", ["library/keiyaku.ts", "Keiyaku"], true],
  ["mcp/adapter.ts", ["library/keiyaku.ts", "Keiyaku"], true],
  ["mcp/adapter.ts", ["cli/render/verbs.ts", "renderVerb"], true],
  ["mcp/adapter.ts", ["git/repository.ts", "repositoryAt"], false],
  ["library/keiyaku.ts", ["mcp/adapter.ts", "createKeiyakuMcpServer"], false],
  ["library/keiyaku.ts", ["library/keiyaku-selectors.ts", "select"], true],
  ["library/keiyaku-selectors.ts", ["library/contract-composition.ts", "Keis"], true],
  ["library/kei.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["library/contract-creation.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["library/contract-composition.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["library/akumas.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["akuma/akuma.ts", ["library/keiyaku-selectors.ts", "Selection", true], false],
  ["debt/index.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["kanshi/read.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["library/address.ts", ["library/keiyaku-selectors.ts", "select"], false],
  ["plugin/runtime.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["body/decode.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["akuma/body.ts", ["library/keiyaku-selectors.ts", "select"], false],
  ["body-host.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["contract-worktree.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["git/repository.ts", ["git/owner-state.ts", "readOwnerState"], true],
  ["git/repository.ts", ["git/internal/owner-state.ts", "readOwnerState"], true],
  ["library/selection.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], true],
  ["library/selection.ts", ["plugin/akuma-signals.ts", "withAkumaWaitDeferrals"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "emitPluginSignal"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "withAkumaWaitDeferrals"], true],
  ["akuma/akuma-instance.ts", ["plugin/akuma-signals.ts", "stderrPluginDiagnostic"], true],
  ["library/akuma-creation.ts", ["akuma/akuma-owner.ts", "forkFailureSchemas"], true],
  ["library/akuma-creation.ts", ["plugin/akuma-signals.ts", "stderrPluginDiagnostic"], true],
  ["library/akuma-creation.ts", ["plugin/akuma-signals.ts", "withAkumaWaitDeferrals"], true],
  ["library/akuma-creation.ts", ["plugin/akuma-signals.ts", "pluginRuntime"], false],
  ["library/selection.ts", ["plugin/akuma-signals.ts", "stderrPluginDiagnostic"], true],
  ["library/akumas.ts", ["akuma/akuma-instance.ts", "captureAkumaHostDiagnostic"], true],
  ["library/akumas.ts", ["akuma/akuma-instance.ts", "AkumaHostOptions", true], true],
  ["library/akuma-retention.ts", ["akuma/retention.ts", "retireInactiveAkuma"], true],
  ["akuma/retention.ts", ["git/observe.ts", "observeContractAt"], false],
  ["akuma/akuma-observe.ts", ["plugin/akuma-signals.ts", "outcomePluginObserver"], false],
  ["akuma/body.ts", ["plugin/akuma-signals.ts", "emitPluginSignal"], true],
  ["akuma/body.ts", ["plugin/akuma-signals.ts", "pluginRuntime"], false],
  ["akuma/body.ts", ["akuma/body-launch.ts", "observeBodyLaunch"], true],
  ["akuma/body.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/body-launch.ts", ["runtime/proc/run.ts", "DetachedProcessExit", true], false],
  ["akuma/publication.ts", ["akuma/body-launch.ts", "LiveBodyLaunch", true], true],
  ["akuma/publication.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/turn-drive.ts", ["runtime/proc/run.ts", "OwnedProcess", true], false],
  ["akuma/detached-body.ts", ["runtime/proc/run.ts", "spawnDetachedProcess"], true],
  ["akuma/in-process-body.ts", ["akuma/body.ts", "driveAkumaBody"], true],
  ["akuma/in-process-body.ts", ["runtime/proc/run.ts", "spawnDetachedProcess"], false],
  ["akuma/akuma-instance.ts", ["body-host.ts", "captureAkumaHost"], true],
  ["library/akumas.ts", ["body-host.ts", "captureAkumaHost"], true],
  ["index.ts", ["body-host.ts", "AkumaHost"], true],
  ["index.ts", ["body-host.ts", "AkumaHostScope", true], true],
  ["index.ts", ["body-host.ts", "captureAkumaHost"], false],
  ["akuma/akuma-instance.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], true],
  ["akuma-body.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], true],
  ["akuma-body.ts", ["body-host.ts", "bodyExecutionContext"], true],
  ["body-host.ts", ["dispatch/index.ts", "readDispatch"], true],
  ["body-host.ts", ["git/repository.ts", "repositoryAt"], true],
  ["library/akumas.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], true],
  ["library/selection.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], false],
  ["library/akuma-creation.ts", ["akuma/detached-body.ts", "spawnAkumaBody"], false],
  ["cli/commands/contract.ts", ["core/verbs/bind.ts", "decideBind"], false],
  ["library/delivery-preview.ts", ["git/target-placement.ts", "observeTargetPlacement"], false],
  ["protocol/delivery-preview.ts", ["core/facts/gate.ts", "gateReports"], true],
  ["protocol/delivery-preview.ts", ["protocol/intent.ts", "verifyRequirement"], false],
  ["protocol/completion.ts", ["core/facts/gate.ts", "gateReports"], true],
  ["protocol/completion.ts", ["verification/execution.ts", "executeVerification"], false],
  ["protocol/delivery-preview.ts", ["protocol/deliver.ts", "prepareDelivery"], true],
  ["protocol/delivery-preview.ts", ["protocol/deliver.ts", "admitDeliveryOperation"], false],
  ["protocol/delivery-preview.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["protocol/delivery-preview.ts", ["verification/execution.ts", "runVerification"], false],
  ["core/facts/fold.ts", ["git/repository.ts", "repositoryAt"], false],
  ["library/contract.ts", ["git/repository.ts", "repositoryAt"], false],
  ["library/contract.ts", ["protocol/attempt.ts", "admitDecidedOffer"], false],
  ["library/contract.ts", ["protocol/review.ts", "reviewOperation"], true],
  ["library/contract-address.ts", ["protocol/operations.ts", "contractsOperation"], true],
  ["library/contract-address.ts", ["library/keiyaku.ts", "Keiyaku"], false],
  ["library/address.ts", ["library/contract-address.ts", "matchContractCandidates"], true],
  ["kanshi/counts.ts", ["git/read-observation.ts", "withGitTargetedReadObservation"], true],
  ["kanshi/counts.ts", ["debt/operations.ts", "observeDebtBoard"], true],
  ["kanshi/counts.ts", ["library/repo.ts", "scopeForRepo"], true],
  ["kanshi/counts.ts", ["world.ts", "World"], true],
  ["kanshi/counts.ts", ["world.ts", "worldRootSchema"], true],
  ["kanshi/counts.ts", ["kanshi/report.ts", "sectionSchema"], true],
  ["kanshi/read.ts", ["git/read-observation.ts", "withGitReadObservation"], true],
  ["kanshi/read.ts", ["body/decode.ts", "decodeContractDocument"], true],
  ["kanshi/read.ts", ["body/region.ts", "assertRegionPattern"], true],
  ["kanshi/report.ts", ["akuma/akuma.ts", "akumaListRowSchema"], false],
  ["kanshi/report.ts", ["akuma/akuma.ts", "listedBornAkumaSchema"], true],
  ["kanshi/report.ts", ["akuma/status-projection.ts", "statusPreviewSchema"], true],
  ["kanshi/report.ts", ["akuma/projection.ts", "activityRowSchema"], false],
  ["kanshi/report.ts", ["core/facts/types.ts", "ContractId", true], true],
  ["kanshi/report.ts", ["akuma/projection.ts", "activitySnapshotSchema"], false],
  ["kanshi/report.ts", ["bounded-list.ts", "boundedListSchema"], true],
  ["kanshi/report.ts", ["identity/selector.ts", "akumaAliasSchema"], true],
  ["kanshi/report.ts", ["protocol/read/observation.ts", "currentPhysicalIssueSchema"], true],
  ["kanshi/report.ts", ["protocol/read/status.ts", "contractRowSchema"], false],
  ["kanshi/report.ts", ["protocol/read/status.ts", "contractSummarySchema"], true],
  ["kanshi/report.ts", ["protocol/read/status.ts", "contractDetailSchema"], true],
  ["kanshi/report.ts", ["debt/index.ts", "debtSummarySchema"], true],
  ["kanshi/report.ts", ["debt/identity.ts", "debtIdSchema"], true],
  ["kanshi/report.ts", ["world.ts", "worldRootSchema"], true],
  ["kanshi/report.ts", ["region.ts", "regionOverlapResultSchema"], true],
  ["kanshi/report.ts", ["region.ts", "regionOverlapSchema"], false],
  ["kanshi/report.ts", ["region.ts", "RegionOverlap", true], true],
  ["kanshi/report.ts", ["library/region.ts", "regionOverlapSchema"], false],
  ["kanshi/report.ts", ["git/identity.ts", "contractIdSchema"], true],
  ["kanshi/report.ts", ["git/identity.ts", "snapshotIdSchema"], false],
  ["region.ts", ["git/identity.ts", "contractIdSchema"], true],
  ["region.ts", ["git/identity.ts", "snapshotIdSchema"], false],
  ["library/region.ts", ["region.ts", "regionOverlapSchema"], true],
  ["library/region.ts", ["region.ts", "regionOverlapResultSchema"], true],
  ["library/outcome.ts", ["library/akuma-creation.ts", "SpawnResult", true], true],
  ["library/outcome.ts", ["library/akuma-creation.ts", "callAkumas"], false],
  ["library/outcome.ts", ["world.ts", "worldRootSchema"], true],
  ["library/outcome.ts", ["world.ts", "World"], false],
  ["kanshi/select.ts", ["body/region.ts", "assertRegionPattern"], true],
  ["kanshi/read.ts", ["git/read-observation.ts", "withGitTargetedReadObservation"], false],
  ["kanshi/read.ts", ["library/region.ts", "regionOverlaps"], false],
  ["kanshi/select.ts", ["library/region.ts", "regionOverlaps"], false],
  ["index.ts", ["library/nuke.ts", "nukeResultSchema"], true],
  ["index.ts", ["kanshi/index.ts", "kanshiCategory"], true],
  ["cli/commands/contract.ts", ["index.ts", "kanshiCategory"], true],
  ["library/contract/moved-owner.ts", ["library/akuma-creation.ts", "createAkuma"], false],
  ["library/contract/moved-owner.ts", ["library/bind.ts", "bind"], false],
  ["library/contract/moved-owner.ts", ["protocol/delivery-preview.ts", "previewDeliveryOperation"], false],
  ["akuma/heart/soul.ts", ["akuma/caller.ts", "decodeAkumaCaller"], true],
  ["akuma/heart/facts.ts", ["akuma/caller.ts", "AkumaCaller", true], true],
  ["akuma/providers/example/adapter.ts", ["akuma/heart/index.ts", "Heart", true], true],
  ["akuma/providers/example/adapter.ts", ["akuma/heart/index.ts", "writeFact"], false],
  ["git/target.ts", ["git/repository.ts", "currentBranch"], true],
  ["git/target.ts", ["git/observe.ts", "observeContractAt"], false],
  ["protocol/operations.ts", ["git/repository.ts", "currentBranch"], true],
  ["protocol/bind.ts", ["git/target-placement.ts", "acquireTargetPlacementFence"], true],
  ["protocol/bind.ts", ["git/target-placement.ts", "prepareTargetPlacement"], false],
  ["protocol/deliver.ts", ["git/target-placement.ts", "acquireTargetPlacementFence"], true],
  ["protocol/deliver.ts", ["git/target-placement.ts", "prepareTargetPlacement"], false],
  ["protocol/operations.ts", ["git/target.ts", "targetWorkspaceRefusalSchema"], true],
  ["cli/render/contract.ts", ["core/facts/types.ts", "targetName"], true],
  ["protocol/operations.ts", ["git/target-placement.ts", "TargetPlacementRefusal", true], true],
  ["protocol/operations.ts", ["git/target-placement.ts", "checkoutNotFollowableRefusalSchema"], true],
  ["protocol/operations.ts", ["git/target-placement.ts", "prepareTargetPlacement"], false],
  ["library/outcome.ts", ["settlement/settle.ts", "settlementLagSchema"], true],
  ["library/outcome.ts", ["settlement/settle.ts", "settleContract"], false],
  ["library/outcome.ts", ["protocol/completion.ts", "CompletionEvidence", true], true],
  ["library/outcome.ts", ["protocol/completion.ts", "compactPlacement"], true],
  ["library/outcome.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["library/outcome.ts", ["protocol/verify.ts", "VerifyValue", true], true],
  ["library/outcome.ts", ["protocol/verify.ts", "verifyOperation"], false],
  ["library/invocation.ts", ["library/outcome.ts", "reconcileLagScope"], true],
  ["library/invocation.ts", ["library/outcome.ts", "project"], false],
  ["library/refusal.ts", ["protocol/completion.ts", "Placement", true], true],
  ["library/refusal.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["protocol/delivery-preview.ts", ["protocol/completion.ts", "unmetGateProblems"], true],
  ["library/kei.ts", ["markdown/query.ts", "sectionContent"], true],
  ["library/kei.ts", ["core/subject.ts", "dependencyKeys"], true],
  ["library/kei.ts", ["core/subject.ts", "currentSubject"], false],
  ["protocol/run.ts", ["git/target-placement.ts", "prepareTargetPlacement"], false],
  ["akuma/akuma.ts", ["library/contract.ts", "contract"], false],
  ["akuma/akuma.ts", ["library/contract.ts", "Contract", true], false],
  ["library/kei.ts", ["protocol/completion.ts", "completeCandidate"], true],
  ["protocol/attempt.ts", ["protocol/result-leaves.ts", "entryUlidSchema"], true],
  ["protocol/execution-observation.ts", ["protocol/result-leaves.ts", "journalEntrySchema"], true],
  ["index.ts", ["protocol/result-leaves.ts", "contractStateSchema"], true],
  ["index.ts", ["protocol/execution-observation.ts", "executionObservationSchema"], true],
  ["protocol/operations.ts", ["protocol/result-leaves.ts", "deliverDataSchema"], true],
  ["protocol/read/status.ts", ["protocol/result-leaves.ts", "gateSchema"], true],
  ["protocol/read/status.ts", ["protocol/result-leaves.ts", "deliverDataSchema"], false],
  ["index.ts", ["protocol/read/status.ts", "contractCatalogueSchema"], true],
  ["library/keiyaku-verbs.ts", ["library/keiyaku-status.ts", "statusResultSchema"], true],
  ["library/contract-types.ts", ["git/identity.ts", "contractIdSchema"], true],
  ["library/outcome.ts", ["protocol/result-leaves.ts", "journalEntrySchema"], true],
  ["library/outcome.ts", ["git/identity.ts", "contractHeadSchema"], true],
  ["library/contract-outcomes.ts", ["library/outcome.ts", "voidOperationOutcomeSchema"], true],
  ["library/contract-outcomes.ts", ["library/region.ts", "regionOverlapSchema"], true],
  ["library/contract-outcomes.ts", ["protocol/result-leaves.ts", "gateSchema"], true],
  ["library/contract-types.ts", ["protocol/result-leaves.ts", "journalEntrySchema"], true],
  ["library/contract-types.ts", ["dispatch/index.ts", "dispatchSchema"], true],
  ["library/contract-types.ts", ["git/workspace.ts", "worktreeWorkspaceSchema"], true],
  ["index.ts", ["library/contract-types.ts", "contractHistorySchema"], true],
  ["library/contract-outcomes.ts", ["protocol/delivery-preview.ts", "deliveryPreviewReportSchema"], true],
  ["library/contract-outcomes.ts", ["protocol/completion.ts", "completionEvidenceShape"], true],
  ["library/outcome.ts", ["protocol/deliver.ts", "materializedConflictSchema"], true],
  ["library/delivery.ts", ["protocol/completion.ts", "completionEvidenceShape"], true],
  ["index.ts", ["library/delivery.ts", "deliverySchema"], true],
  ["library/contract-outcomes.ts", ["git/workspace.ts", "worktreeWorkspaceSchema"], true],
  ["index.ts", ["library/contract-outcomes.ts", "arcOutcomeSchema"], true],
  ["library/reconcile.ts", ["settlement/settle.ts", "settlementReportSchema"], true],
  ["index.ts", ["library/reconcile.ts", "reconcileResultSchema"], true],
  ["index.ts", ["library/contract-types.ts", "contractResolutionSchema"], true],
  ["index.ts", ["library/kei.ts", "guidanceSchema"], true],
  ["library/contract-wait.ts", ["git/identity.ts", "contractHeadSchema"], true],
  ["index.ts", ["library/contract-wait.ts", "contractWaitResultSchema"], true],
  ["index.ts", ["library/kei.ts", "Kei"], true],
  ["index.ts", ["library/contract-composition.ts", "Keis"], true],
  ["library/contract-creation.ts", ["library/bind.ts", "prepareMarkdownBind"], true],
  ["library/invocation.ts", ["protocol/completion.ts", "completeCandidate"], false],
  ["library/invocation.ts", ["protocol/progress.ts", "ProtocolProgress", true], true],
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
  "turn-drive",
  "akuma-owner",
  "akuma-call",
  "akuma-selection-execution",
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
for (const owner of ["kei", "continuation"]) {
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
    "library/kei.ts",
    [
      ["library/contract-composition.ts", "composeContractLibrary"],
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
  ["region.ts", "zod", "z", ""],
  ["region.ts", "zod", "other", "capability-import"],
  ["bounded-list.ts", "zod", "z", ""],
  ["library/contract-wait.ts", "zod", "z", ""],
  ["library/contract-types.ts", "zod", "z", ""],
  ["library/contract-outcomes.ts", "zod", "z", ""],
  ["library/delivery.ts", "zod", "z", ""],
  ["library/kei.ts", "zod", "z", ""],
  ["protocol/result-leaves.ts", "zod", "z", ""],
  ["protocol/read/status.ts", "zod", "z", ""],
  ["identity/selector.ts", "zod", "z", ""],
  ["alias/index.ts", "zod", "z", ""],
  ["dispatch/index.ts", "zod", "z", ""],
  ["bounded-list.ts", "zod", "other", "capability-import"],
  ["protocol/read/observation.ts", "zod", "z", ""],
  ["protocol/read/observation.ts", "zod", "other", "capability-import"],
  ["kanshi/counts.ts", "zod", "z", ""],
  ["kanshi/counts.ts", "zod", "other", "capability-import"],
  ["kanshi/read.ts", "zod", "z", ""],
  ["kanshi/read.ts", "zod", "other", "capability-import"],
  ["kanshi/report.ts", "zod", "z", ""],
  ["kanshi/report.ts", "zod", "other", "capability-import"],
  ["settings.ts", "zod", "z", ""],
  ["settings.ts", "zod", "other", "capability-import"],
  ["world.ts", "zod", "z", ""],
  ["world.ts", "zod", "other", "capability-import"],
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
