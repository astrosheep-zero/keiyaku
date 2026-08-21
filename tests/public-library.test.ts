import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTwoFilesPatch } from "diff";
import { Delivery, Keiyaku, KeiyakuRefused, KeiyakuRetry, Repo, type ContractId } from "../src/index.js";
import { contractId, documentKey } from "../src/core/facts/types.js";
import { withGitDecodeChannel } from "../src/git/read-observation.js";
import { repositoryAt } from "../src/git/repository.js";
import { bindOperation } from "../src/protocol/bind.js";
import { makeGitRepository } from "./support/git.js";

const root = resolve(import.meta.dirname, "..");

function externalConsumer(): string {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-consumer-"));
  mkdirSync(join(directory, "node_modules", "@astrosheep"), { recursive: true });
  symlinkSync(root, join(directory, "node_modules", "@astrosheep", "keiyaku"), "dir");
  writeFileSync(join(directory, "package.json"), '{"type": "module"}\n');
  return directory;
}

function markdown(title = "Boundary", verification?: string): string {
  return [
    `# ${title}`,
    "",
    "## Context",
    "context",
    "",
    "## Objective",
    "objective",
    "",
    "## Design",
    "design",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### C1",
    "criterion",
    ...(verification === undefined ? [] : ["", "## Verification", "~~~bash", verification, "~~~"]),
    "",
  ].join("\n");
}

function repositoryWithInitialCommit() {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

test("package root exposes only the ruled library values and declarations", () => {
  const directory = externalConsumer();
  const source = [
    'import { AuthorityCorruptionError, AkumaWorldScopeError, Delivery, gatesFrom, Keiyaku, KeiyakuRefused, KeiyakuRetry, Repo, settings, SettingsError, worktreeHooksFrom, World, type AbandonInput, type ActorId, type AkumaHistoryResult, type AkumaObservation, type AkumaWorldScopeRefusal, type AmendInput, type ArcInput, type AuditInput, type AuditReport, type AttestationVerdict, type BindInput, type BindResult, type ChangeId, type ContractAfterEdge, type ContractBoard, type ContractDependent, type ContractDisposition, type ContractGateCurrent, type ContractGateReport, type ContractHistory, type ContractHistoryEvent, type ContractId, type ContractObservation, type ContractObservationInput, type ContractListInput, type ContractPhase, type ContractRow, type ContractState, type ContractWorkspaceObservation, type CreatedTaskObservation, type DeliverInput, type DeliveryPreparationRefusal, type Fact, type FactKind, type Gate, type HookCommand, type KeiyakuRefusal, type KeiyakuRetryReason, type Lag, type MutationResult, type NukeConfirmationRefusal, type NukeConfirmationRequiredRefusal, type NukeInput, type NukeResult, type ReconcileReport, type RegionOverlap, type RepoAtInput, type RepoReconcileReport, type Review, type ReviewInput, type Settings, type SettingsEntry, type SettingsNamespaceView, type SettingsScopeState, type SettlementAction, type SettlementLag, type SettlementReport, type SnapshotId, type TaskId, type TopologyEffect, type VerificationReuse, type WorktreeHooks, type WorldResolution, type WorldResolutionInput, type WorldRoot } from "@astrosheep/keiyaku";',
    'import type { AkuId, AkumaAlias, AkumaStatus, AliasBinding, AliasStage, CallInput, CallResult, Dispatch, DispatchFailure, DispatchStage, ForkInput, ForkResult, IntegrationFailure } from "@astrosheep/keiyaku";',
    'const repo = await Repo.at({ path: "." });',
    'import { requireBranchesToBeUpToDateFrom } from "@astrosheep/keiyaku";',
    'const id = "kei/consumer" as ContractId;',
    'const taskId = "task/consumer" as TaskId;',
    'const input: BindInput = { repo, task: taskId, markdown: "# T\\n\\n## Context\\nC\\n\\n## Objective\\nO\\n\\n## Design\\nD\\n\\n## Region\\n~~~\\nsrc/**\\n~~~\\n\\n## Criteria\\n### C1\\nB\\n", after: [id], gates: ["reviewed"] };',
    'const amendment: AmendInput = { markdown: "## Append: Context\\nMore\\n", after: [id] };',
    'const termsOnly: AmendInput = { after: [id] };',
    'const existing = Keiyaku.of({ repo, id });',
    'const akuma = "aku/worker/1234abcd" as AkuId;',
    'const alias = "@worker" as AkumaAlias;',
    'const world = null as unknown as WorldRoot;',
    'const nukeInput: NukeInput = { world, confirm: world };',
    'const nukeResult: Promise<NukeResult> = Keiyaku.nuke(nukeInput);',
    'const nukeRefusal: NukeConfirmationRefusal = { kind: "nuke-confirmation-mismatch", world, confirmation: "wrong" };',
    'const nukeRequired: NukeConfirmationRequiredRefusal = { kind: "nuke-confirmation-required", world };',
    'const nukeKeiyakuRefusal: KeiyakuRefusal = nukeRefusal;',
    'const worldResult: Promise<WorldRoot> = World.at(".");',
    'const worldInput: WorldResolutionInput = { cwd: "." };',
    'const worldResolution: Promise<WorldResolution> = World.resolve(worldInput);',
    'const worldCandidate: WorldRoot | null = (await worldResolution).candidate;',
    'const callInput: CallInput = { path: world, archetype: "worker", body: "work", mode: "wait", timeoutMs: 300000, contract: existing, alias };',
    'const callResult: Promise<CallResult> = Keiyaku.call(callInput);',
    'const callStatus = null as unknown as AkumaStatus;',
    'const forkInput: ForkInput = { path: world, akuma, at: "history-1", repo };',
    'const forkResult: Promise<ForkResult> = Keiyaku.fork(forkInput);',
    'const statusResult: Promise<AkumaObservation> = Keiyaku.status({ path: world, akuma });',
    'const createdTasks: CreatedTaskObservation = { kind: "present", rows: [] };',
    'const historyResult: Promise<AkumaHistoryResult> = Keiyaku.history({ path: world, akuma });',
    'const contractHistory: Promise<ContractHistory> = existing.history();',
    'const contractHistoryEvent = null as unknown as ContractHistoryEvent;',
    'const aliasBinding = null as unknown as AliasBinding;',
    'const aliasStage = null as unknown as AliasStage;',
    'const dispatch = null as unknown as Dispatch;',
    'const dispatchFailure = null as unknown as DispatchFailure;',
    'const dispatchStage = null as unknown as DispatchStage;',
    'const integrationFailure = null as unknown as IntegrationFailure;',
    'const delivery = null as unknown as Delivery;',
    '// @ts-expect-error Keiyaku has a private constructor',
    'new Keiyaku();',
    '// @ts-expect-error Repo.at accepts one input object',
    'await Repo.at(".");',
    '// @ts-expect-error Delivery.review accepts one input object',
    'delivery.review("satisfied");',
    '// @ts-expect-error Delivery has no public constructor',
    'new Delivery();',
    '// @ts-expect-error Keiyaku.of requires a branded ContractId',
    'Keiyaku.of({ repo, id: "kei/unbranded" });',
    '// @ts-expect-error BindInput.after requires branded ContractId values',
    'const invalidBind: BindInput = { ...input, after: ["kei/unbranded"] };',
    '// @ts-expect-error AmendInput.after requires branded ContractId values',
    'const invalidAmend: AmendInput = { ...amendment, after: ["kei/unbranded"] };',
    'const customGate: Gate = "edge-owned";',
    'const settingsValue = null as unknown as Settings;',
    'const settingsResult: Promise<Settings> = settings({ root: world });',
    'const selectedGates: readonly Gate[] = gatesFrom({ settings: settingsValue, names: ["strict", "review-only"] });',
    '// @ts-expect-error gatesFrom removed the singular name selector',
    'gatesFrom({ settings: settingsValue, name: "strict" });',
    'const hook: HookCommand = { argv: ["npm", "ci"], timeoutMs: 300000 };',
    'const selectedHooks: WorktreeHooks = worktreeHooksFrom({ settings: settingsValue });',
    'const requireUpToDate: boolean = requireBranchesToBeUpToDateFrom({ settings: settingsValue });',
    'const settingsEntry = null as unknown as SettingsEntry;',
    'const settingsView = null as unknown as SettingsNamespaceView;',
    'const settingsScope = null as unknown as SettingsScopeState;',
    '// @ts-expect-error abandon accepts options, not a reason enum',
    'existing.abandon("manual");',
    'const bound: Promise<BindResult> = Keiyaku.bind(input);',
    '// @ts-expect-error Repo is not a second contract-construction surface',
    'repo.bind(input);',
    '// @ts-expect-error Receipt was removed from the package-root surface',
    'type Receipt = import("@astrosheep/keiyaku").Receipt;',
    'const report = null as unknown as AuditReport;',
    'const preparationRefusal = null as unknown as DeliveryPreparationRefusal;',
    'const verificationReuse = null as unknown as VerificationReuse;',
    'const kind = null as unknown as FactKind;',
    'const abandonInput = null as unknown as AbandonInput;',
    'const actor = null as unknown as ActorId;',
    'const arcInput = null as unknown as ArcInput;',
    'const auditInput = null as unknown as AuditInput;',
    'const verdict = null as unknown as AttestationVerdict;',
    'const bindResult = null as unknown as BindResult;',
    'const change = null as unknown as ChangeId;',
    'const state = null as unknown as ContractState;',
    'const contractListInput: ContractListInput = { repo };',
    'const contractObservationInput: ContractObservationInput = { repo, id };',
    'const contractPhase: ContractPhase = "bound";',
    'const contractDisposition: ContractDisposition = "active";',
    'const contractGateCurrent: ContractGateCurrent = { kind: "missing" };',
    'const contractGateReport: ContractGateReport = { gate: "custom", current: contractGateCurrent };',
    'const workspaceObservation: ContractWorkspaceObservation = { kind: "clean", location: { kind: "here" }, counts: { staged: 0, unstaged: 0, untracked: 0, submodules: 0 }, merge: null };',
    'const failedWorkspaceObservation: ContractWorkspaceObservation = { kind: "failed", diagnostic: "duplicate appointment" };',
    'const after: ContractAfterEdge[] = [{ contractId: id, endpoint: { kind: "active", phase: contractPhase } }];',
    'const dependents: ContractDependent[] = [{ contractId: id, phase: contractPhase }];',
    'const statusRow: ContractRow = { id, title: "Boundary", phase: contractPhase, phaseAt: "2026-08-16T00:00:00.000Z", lastJournalAt: "2026-08-16T00:00:01.000Z", disposition: contractDisposition, workspace: "here", worktreePath: null, workspaceObservation, target: null, targetLag: { kind: "none" }, delivery: null, targetObservation: null, gates: { reports: [contractGateReport], satisfied: false }, after, dependents };',
    'const statusBoard: ContractBoard = { root: ".", state: null, observedAt: "2026-08-16T00:00:02.000Z", rows: [statusRow] };',
    'const statusObservation: ContractObservation = { kind: "present", row: statusRow };',
    'const deliverInput = null as unknown as DeliverInput;',
    'const fact = null as unknown as Fact;',
    'const gate = null as unknown as Gate;',
    'const reconcile = null as unknown as ReconcileReport;',
    'const atInput = null as unknown as RepoAtInput;',
    'const repoReconcile = null as unknown as RepoReconcileReport;',
    'const emptyWorld: RepoReconcileReport = { kind: "completed", contracts: [] };',
    'const failedWorld: RepoReconcileReport = { kind: "world-observation-failed", diagnostic: "git failed" };',
    'const completedWorld: Extract<RepoReconcileReport, { kind: "completed" }> = { kind: "completed", contracts: [{ contractId: id, report: { effects: [], lag: [], settlement: { actions: [], lags: [] } } }] };',
    '// @ts-expect-error world-observation-failed requires diagnostic',
    'const invalidFailedWorld: RepoReconcileReport = { kind: "world-observation-failed" };',
    '// @ts-expect-error completed cannot omit contracts',
    'const invalidCompletedWorld: RepoReconcileReport = { kind: "completed" };',
    '// @ts-expect-error failed world is not the completed arm',
    'const failedAsCompleted: Extract<RepoReconcileReport, { kind: "completed" }> = failedWorld;',
    'const reviewInput = null as unknown as ReviewInput;',
    'const review = null as unknown as Review;',
    'const regionOverlap = null as unknown as RegionOverlap;',
    'const snapshot = null as unknown as SnapshotId;',
    'const refusal = null as unknown as KeiyakuRefusal;',
    'const retry = null as unknown as KeiyakuRetryReason;',
    'const mutation = null as unknown as MutationResult<void>;',
    'const effect = null as unknown as TopologyEffect;',
    'const lag = null as unknown as Lag;',
    'const settlementAction = null as unknown as SettlementAction;',
    'const settlementLag = null as unknown as SettlementLag;',
    'const settlementReport = null as unknown as SettlementReport;',
    'const refusedError = null as unknown as KeiyakuRefused;',
    'const retryError = null as unknown as KeiyakuRetry;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAbandonData = import("@astrosheep/keiyaku").AbandonData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAbandonedData = import("@astrosheep/keiyaku").AbandonedData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAttestationData = import("@astrosheep/keiyaku").AttestationData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAmendData = import("@astrosheep/keiyaku").AmendData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalBindData = import("@astrosheep/keiyaku").BindData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalBoundData = import("@astrosheep/keiyaku").BoundData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalClaimedData = import("@astrosheep/keiyaku").ClaimedData;',
    '// @ts-expect-error internal journal coordinate is not a package-root export',
    'type InternalCoordinates = import("@astrosheep/keiyaku").ContractCoordinates;',
    '// @ts-expect-error internal journal body part is not a package-root export',
    'type InternalCriterion = import("@astrosheep/keiyaku").ContractCriterion;',
    '// @ts-expect-error internal journal body part is not a package-root export',
    'type InternalExtension = import("@astrosheep/keiyaku").ContractExtension;',
    '// @ts-expect-error internal journal alias is not a package-root export',
    'type InternalHead = import("@astrosheep/keiyaku").ContractHead;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalDeliverData = import("@astrosheep/keiyaku").DeliverData;',
    '// @ts-expect-error internal journal identity is not a package-root export',
    'type InternalEntryUlid = import("@astrosheep/keiyaku").EntryUlid;',
    '// @ts-expect-error internal input helper is not a package-root export',
    'type InternalActorOptions = import("@astrosheep/keiyaku").ActorOptions;',
    '// @ts-expect-error internal subject identity is not a package-root export',
    'type InternalSubject = import("@astrosheep/keiyaku").SubjectKey;',
    '// @ts-expect-error internal verification data is not a package-root export',
    'type InternalVerification = import("@astrosheep/keiyaku").VerificationDeclaration;',
    '// @ts-expect-error internal verification data is not a package-root export',
    'type InternalExecutor = import("@astrosheep/keiyaku").VerificationExecutor;',
    '// @ts-expect-error internal verification refusal has no separate package-root name',
    'type InternalVerificationRefusal = import("@astrosheep/keiyaku").VerificationDeclarationRefusal;',
    '// @ts-expect-error legacy ReviewResult alias is not a package-root export',
    'type InternalReviewResult = import("@astrosheep/keiyaku").ReviewResult;',
    '// @ts-expect-error legacy ReviewValue alias is not a package-root export',
    'type InternalReviewValue = import("@astrosheep/keiyaku").ReviewValue;',
    '// @ts-expect-error legacy DeliverValue alias is not a package-root export',
    'type InternalDeliverValue = import("@astrosheep/keiyaku").DeliverValue;',
    'void new AuthorityCorruptionError("corrupt"); void new AkumaWorldScopeError({ kind: "akuma-not-in-world", ids: [akuma], world }); void (null as unknown as AkumaWorldScopeRefusal); void new SettingsError("invalid"); void existing; void delivery; void bound; void repo; void taskId; void akuma; void alias; void worldInput; void worldResolution; void callResult; void callStatus; void forkResult; void statusResult; void createdTasks; void historyResult; void contractHistory; void contractHistoryEvent; void aliasBinding; void aliasStage; void dispatch; void dispatchFailure; void dispatchStage; void integrationFailure; void report; void preparationRefusal; void verificationReuse; void kind; void amendment; void termsOnly; void invalidBind; void invalidAmend; void customGate; void settingsValue; void selectedGates; void hook; void selectedHooks; void settingsEntry; void settingsView; void settingsScope; void contractListInput; void contractObservationInput; void contractPhase; void contractDisposition; void contractGateCurrent; void contractGateReport; void workspaceObservation; void failedWorkspaceObservation; void statusRow; void statusBoard; void statusObservation; void deliverInput; void fact; void gate; void reconcile; void atInput; void repoReconcile; void emptyWorld; void failedWorld; void completedWorld; void invalidFailedWorld; void invalidCompletedWorld; void failedAsCompleted; void reviewInput; void review; void regionOverlap; void snapshot; void refusal; void retry; void settlementAction; void settlementLag; void settlementReport; void nukeResult; void nukeKeiyakuRefusal; void nukeRequired;',
  ].join("\n");
  writeFileSync(join(directory, "consumer.ts"), source);
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "consumer.ts"], { cwd: directory, stdio: "ignore" });
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("@astrosheep/keiyaku"); console.log(Object.keys(m).filter((key) => key !== "requireBranchesToBeUpToDateFrom").sort().join(","));'], { cwd: directory, encoding: "utf8" });
  assert.equal(output.trim(), "AkumaWorldScopeError,AuthorityCorruptionError,Delivery,Keiyaku,KeiyakuRefused,KeiyakuRetry,NoGitWorldError,Repo,SettingsError,World,WorldError,gatesFrom,settings,worktreeHooksFrom");
});

test("package exports reject deep internal imports", () => {
  const directory = externalConsumer();
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("@astrosheep/keiyaku/build/src/core/facts/types.js")'], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }),
    (error: unknown) => {
      const value = error as { stderr?: Buffer };
      return value.stderr?.toString("utf8").includes("ERR_PACKAGE_PATH_NOT_EXPORTED") === true;
    },
  );
});

test("task package export exposes only the Tasks-first native surface", () => {
  const directory = externalConsumer();
  const source = [
    'import { World } from "@astrosheep/keiyaku";',
    'import { Tasks, type Task, type TaskDecompositionTree, type TaskId, type TaskMutationResult, type TaskTreeNode } from "@astrosheep/keiyaku/task";',
    'const world = null as unknown as import("@astrosheep/keiyaku").WorldRoot;',
    'const tasks = Tasks.of(world);',
    'const task: Task = tasks.task({ id: "task/example" });',
    'const id: TaskId = task.id;',
    'const result: Promise<TaskMutationResult> = tasks.add({ title: "Example", state: "in_progress", note: "initial" });',
    'const tree: Promise<TaskDecompositionTree> = task.tree();',
    'const node = null as unknown as TaskTreeNode;',
    'void task.update({ note: "replacement" });',
    'void task.drop({ note: "obsolete" });',
    '// @ts-expect-error Task has no static construction surface',
    'Task.at({ path: "." });',
    '// @ts-expect-error callers do not choose IDs during creation',
    'tasks.add({ id: "task/chosen", title: "Chosen" });',
    '// @ts-expect-error tree accepts no full option',
    'void task.tree({ full: true });',
    '// @ts-expect-error DAG residue type is not exported',
    'type OldTree = import("@astrosheep/keiyaku/task").TaskDependencyTree;',
    'void tasks; void task; void id; void result; void tree; void node;',
  ].join("\n");
  writeFileSync(join(directory, "consumer-task.ts"), source);
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "consumer-task.ts"], { cwd: directory, stdio: "ignore" });
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("@astrosheep/keiyaku/task"); console.log(Object.keys(m).sort().join(","));'], { cwd: directory, encoding: "utf8" });
  assert.equal(
    output.trim(),
    "TASK_RELATION_PREDICATE_FIELDS,TaskAuthorityCorruptionError,Tasks,observeTaskDetails",
  );
});

test("built CLI bin keeps its shebang and executes through an installed-style symlink", () => {
  const repository = repositoryWithInitialCommit();
  const bin = join(root, "build", "src", "cli", "index.js");
  const linkDirectory = mkdtempSync(join(tmpdir(), "keiyaku-v4-bin-"));
  const link = join(linkDirectory, "keiyaku");
  assert.equal(readFileSync(bin, "utf8").split("\n", 1)[0], "#!/usr/bin/env node");
  assert.notEqual(statSync(bin).mode & 0o111, 0, "build must make the CLI entry executable");
  symlinkSync(bin, link);
  const output = execFileSync(link, ["status", "--json"], { cwd: repository.path, encoding: "utf8" });
  assert.equal(JSON.parse(output).contracts.kind, "present");
});

test("Keiyaku owns contract construction over one pinned Repo capability", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  assert.deepEqual(Object.getOwnPropertyNames(Keiyaku).filter((name) => !["length", "name", "prototype"].includes(name)).sort(), [
    "bind", "call", "fork", "history", "interrupt", "kill", "list", "ls", "nuke", "observe", "of", "status", "tell", "wait",
  ]);
  assert.deepEqual(Object.getOwnPropertyNames(Delivery).filter((name) => !["length", "name", "prototype"].includes(name)), []);
  assert.deepEqual(Object.getOwnPropertyNames(Repo).filter((name) => !["length", "name", "prototype"].includes(name)), ["at"]);
  assert.deepEqual(Object.getOwnPropertyNames(Repo.prototype).filter((name) => name !== "constructor").sort(), ["currentBranch", "reconcile"]);
  assert.equal(await repo.currentBranch(), "refs/heads/main");
  await assert.rejects(
    Keiyaku.bind({ repo, markdown: markdown("Invalid gate"), workspace: "here", gates: ["Edge-owned"] }),
    (error: unknown) => error instanceof TypeError && error.message === "gates[0] must match ^[a-z][a-z0-9-]{0,63}$",
  );
  await assert.rejects(
    Keiyaku.bind({ repo,
      markdown: markdown("Duplicate gate"),
      workspace: "here",
      gates: ["reviewed", "reviewed"],
    }),
    (error: unknown) => error instanceof TypeError && error.message === "gates must not contain duplicates",
  );

  const bound = await Keiyaku.bind({ repo,
    markdown: markdown("Markdown input"),
    workspace: "here",
  });
  const state = await bound.keiyaku.state();
  assert.equal(state.id, "kei/markdown-input");
  assert.equal(state.terms.document.bytes, markdown("Markdown input"));
  assert.deepEqual(state.terms.after, []);
  assert.deepEqual(state.terms.gates, []);
  const guidance = await bound.keiyaku.guidance();
  assert.ok(guidance.startsWith(
    "---\ncontract: kei/markdown-input\ndescription: This is a read-only projection. Do not edit manually.\n---\n\n",
  ));
  assert.ok(guidance.includes(markdown("Markdown input")));
  assert.equal(guidance.match(/^## Fulfillment$/gmu)?.length, 1);
  assert.equal(readFileSync(resolve(repo.root, ".keiyaku", "KEIYAKU.md"), "utf8"), guidance);

  const sameTitle = await Keiyaku.bind({ repo, markdown: markdown("Markdown input"), workspace: "worktree" });
  assert.match((await sameTitle.keiyaku.state()).id, /^kei\/markdown-input-[0-9a-f]{16}$/);

  assert.equal(repo.root, resolve(repo.root));
  assert.equal((await Keiyaku.list({ repo })).rows.some((contract) => contract.id === state.id), true);
  await assert.rejects(
    Keiyaku.of({ repo, id: "kei/missing" as ContractId }).amend({ markdown: "## Append: Context\nmissing\n" }),
    (error: unknown) => error instanceof KeiyakuRefused
      && assert.deepEqual(error.refusal, { kind: "contract-missing", contractId: "kei/missing" }) === undefined,
  );
});

test("package-root observe and list carry failed here workspace observations", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Duplicate here workspace"), workspace: "here" });
  const linked = join(mkdtempSync(join(tmpdir(), "keiyaku-public-library-linked-")), "worktree");
  repository.run(["worktree", "add", "--detach", linked, "HEAD"]);
  const appointment = readFileSync(join(repository.path, ".keiyaku", "KEIYAKU.md"));
  mkdirSync(join(linked, ".keiyaku"), { recursive: true });
  writeFileSync(join(linked, ".keiyaku", "KEIYAKU.md"), appointment);

  const observed = await Keiyaku.observe({ repo, id: bound.keiyaku.id });
  assert.equal(observed.kind, "present");
  if (observed.kind !== "present") return;
  const listed = await Keiyaku.list({ repo });
  const listedRow = listed.rows.find((row) => row.id === bound.keiyaku.id);

  for (const row of [observed.row, listedRow]) {
    assert.equal(row?.worktreePath, null);
    assert.equal(row?.workspaceObservation.kind, "failed");
    if (row?.workspaceObservation.kind === "failed") {
      assert.match(row.workspaceObservation.diagnostic, /duplicate here Contract workspace appointments/u);
    }
  }

  repository.run(["worktree", "remove", "--force", linked]);
});

test("public handle values are type tokens, not alternate constructors", () => {
  assert.throws(() => Reflect.construct(Keiyaku as unknown as Function, []), TypeError);
  assert.throws(() => Reflect.construct(Delivery as unknown as Function, []), TypeError);
});

test("bind canonicalizes branch targets and refuses invalid names before birth", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Short target"), target: "main", workspace: "here" });
  assert.equal((await bound.keiyaku.state()).coordinates.target, "refs/heads/main");

  const gitBefore = repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim();
  for (const target of ["bad..name", "keiyaku-state", "refs/tags/main"]) {
    await assert.rejects(
      Keiyaku.bind({ repo, markdown: markdown("Invalid target"), target, workspace: "worktree" }),
      (error: unknown) => error instanceof KeiyakuRefused && error.code === "invalid-target",
    );
    assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), gitBefore);
  }

  await assert.rejects(
    Keiyaku.bind({ repo, markdown: markdown("Missing target"), target: "missing", workspace: "worktree" }),
    (error: unknown) => error instanceof KeiyakuRefused && error.code === "target-missing",
  );
  assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), gitBefore);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "refs/heads/missing"]), "");
});

test("public amend rejects a transitive prerequisite cycle without moving its head", async () => {
  const repo = await Repo.at({ path: repositoryWithInitialCommit().path });
  const prerequisite = await Keiyaku.bind({ repo, markdown: markdown("Prerequisite"), workspace: "here" });
  const prerequisiteId = (await prerequisite.keiyaku.state()).id;

  const amended = await Keiyaku.bind({ repo,
    markdown: markdown("Amended"),
    workspace: "worktree",
    after: [prerequisiteId],
  });
  const amendedId = (await amended.keiyaku.state()).id;

  const dependent = await Keiyaku.bind({ repo,
    markdown: markdown("Dependent"),
    workspace: "worktree",
    after: [amendedId],
  });
  const dependentId = (await dependent.keiyaku.state()).id;
  const head = (await amended.keiyaku.state()).head;

  await assert.rejects(
    amended.keiyaku.amend({ markdown: "## Append: Context\ncycle\n", after: [dependentId] }),
    (error: unknown) => error instanceof KeiyakuRefused
      && assert.deepEqual(error.refusal, { kind: "cyclic-prerequisite", contractId: amendedId }) === undefined,
  );
  assert.equal((await amended.keiyaku.state()).head, head);
});

test("amend applies Markdown once and preserves structured values unless replaced", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: markdown("Amend input"), workspace: "here" });

  await assert.rejects(
    bound.keiyaku.amend({ markdown: "## Append: Context\ninvalid gate\n", gates: ["Edge-owned"] }),
    (error: unknown) => error instanceof TypeError && error.message === "gates[0] must match ^[a-z][a-z0-9-]{0,63}$",
  );
  await assert.rejects(
    bound.keiyaku.amend({ actor: "operator" }),
    (error: unknown) => error instanceof TypeError && error.message === "amend requires markdown, after, or gates",
  );

  await bound.keiyaku.amend({
    markdown: ["## Replace: Verification", "~~~bash", "exit 0", "~~~", ""].join("\n"),
    gates: ["verified"],
  });
  const beforePreserved = await bound.keiyaku.state();
  assert.deepEqual(beforePreserved.terms.gates, ["verified"]);

  const preserved = await bound.keiyaku.amend({
    markdown: ["## Append: Context", "more context", ""].join("\n"),
    after: [],
  });
  const state = await bound.keiyaku.state();
  assert.equal(
    preserved.documentDiff,
    createTwoFilesPatch(
      "before",
      "after",
      beforePreserved.terms.document.bytes,
      state.terms.document.bytes,
      "",
      "",
      { context: 3 },
    ),
  );
  assert.deepEqual(state.terms.after, []);
  assert.deepEqual(state.terms.gates, ["verified"]);
  assert.match(state.terms.document.bytes, /context\n\nmore context\n/);
});

test("arc decodes its Markdown input and worktree paths are computed", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = await Repo.at({ path: repository.path });
  const here = await Keiyaku.bind({ repo, markdown: markdown("Arc input"), workspace: "here" });
  await here.keiyaku.arc({
    markdown: ["# Chapter", "", "## Objective", "advance", "", "## Brief", "dispatch", ""].join("\n"),
  });
  assert.equal((await here.keiyaku.state()).currentArc?.data.seq, 1);

  const managed = await Keiyaku.bind({ repo, markdown: markdown("Managed"), workspace: "worktree" });
  const status = await Keiyaku.list({ repo });
  const managedState = await managed.keiyaku.state();
  assert.equal(typeof status.rows.find((contract) => contract.id === managedState.id)?.worktreePath, "string");
});

async function occupyContract(repositoryPath: string, id: ContractId) {
  const git = await repositoryAt(repositoryPath);
  const occupied = await withGitDecodeChannel(git, (channel) => bindOperation({
    scope: git,
    channel,
    contractId: id,
    terms: {
      document: { bytes: "# Occupied\n", key: documentKey("occupied") },
      segments: [],
      gates: [],
      after: [],
    },
    verification: { kind: "prepared", data: null },
    workspace: "worktree",
  }));
  assert.equal(occupied.kind, "accepted");
}

test("library bind retries a colliding title stem with a hexadecimal suffix", async () => {
  const repository = repositoryWithInitialCommit();
  await occupyContract(repository.path, contractId("kei/collision-title"));
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: markdown("Collision title"),
    workspace: "worktree",
  });
  assert.match((await bound.keiyaku.state()).id, /^kei\/collision-title-[0-9a-f]{16}$/);
});

test("a non-collision here refusal stops after the first candidate and releases its reservation", async () => {
  const repository = repositoryWithInitialCommit();
  const appointment = resolve(repository.path, ".keiyaku", "KEIYAKU.md");
  await assert.rejects(
    Keiyaku.bind({
      repo: await Repo.at({ path: repository.path }),
      markdown: markdown("Stop after refusal"),
      workspace: "here",
      after: ["kei/missing-prerequisite" as ContractId],
    }),
    (error: unknown) => error instanceof KeiyakuRefused
      && error.refusal.kind === "unknown-prerequisite"
      && error.refusal.contractId === "kei/stop-after-refusal",
  );
  assert.equal(existsSync(appointment), false);
});

test("ordinary review retains its complete local mutation result without a request channel", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: markdown("Local review"),
    workspace: "here",
    gates: ["reviewed"],
  });

  const result = await bound.keiyaku.review({ verdict: "unsatisfied", summary: "needs work" });

  const attestation = result.facts.find((fact) => fact.kind === "attestation");
  assert.equal(attestation?.kind, "attestation");
  assert.equal(attestation?.data.verdict, "unsatisfied");
  assert.equal((await bound.keiyaku.state()).attestations.at(-1)?.data.summary, "needs work");
});

test("Delivery.diff remains a nullable Promise-backed Git read", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ repo: await Repo.at({ path: repository.path }), markdown: markdown("Diff input"), workspace: "here" });
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const delivered = await bound.keiyaku.deliver();
  const diff = await delivered.value.diff();
  assert.equal(typeof diff, "string");
  assert.match(diff, /candidate\.txt/);
});
