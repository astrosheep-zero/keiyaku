import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTwoFilesPatch } from "diff";
import { Delivery, Keiyaku, Repo, type ContractId } from "../src/index.js";
import { makeGitRepository } from "./support/git.js";

const root = resolve(import.meta.dirname, "..");

test.before(() => {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "ignore" });
});

function externalConsumer(): string {
  const directory = mkdtempSync(join(tmpdir(), "keiyaku-v4-consumer-"));
  mkdirSync(join(directory, "node_modules", "@astrosheep"), { recursive: true });
  symlinkSync(root, join(directory, "node_modules", "@astrosheep", "keiyaku-v4"), "dir");
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
    'import { AuthorityCorruptionError, Delivery, Keiyaku, Repo, type AbandonInput, type ActorId, type AmendInput, type ArcInput, type AuditInput, type AuditReport, type AttestationVerdict, type BindInput, type BindResult, type ChangeId, type ContractId, type ContractState, type ContractStatus, type DeliverInput, type Fact, type FactKind, type Gate, type Outcome, type ReconcileReport, type RegionOverlap, type RepoAtInput, type RepoReconcileReport, type Review, type ReviewInput, type SnapshotId, type StatusInput, type StatusReport, type TimelineEntry, type TypedRefusal, type TypedRetry } from "@astrosheep/keiyaku-v4";',
    'const repo = Repo.at({ path: "." });',
    'const id = "kei/consumer" as ContractId;',
    'const input: BindInput = { repo, markdown: "# T\\n\\n## Context\\nC\\n\\n## Objective\\nO\\n\\n## Design\\nD\\n\\n## Region\\n~~~\\nsrc/**\\n~~~\\n\\n## Criteria\\n### C1\\nB\\n", after: [id], gates: ["reviewed"] };',
    'const amendment: AmendInput = { markdown: "## Append: Context\\nMore\\n", after: [id] };',
    'const existing = Keiyaku.of({ repo, id });',
    'const delivery = null as unknown as Delivery;',
    '// @ts-expect-error Keiyaku has a private constructor',
    'new Keiyaku();',
    '// @ts-expect-error Repo.at accepts one input object',
    'Repo.at(".");',
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
    '// @ts-expect-error Gate is a closed public vocabulary',
    'const invalidGate: Gate = "edge-owned";',
    '// @ts-expect-error abandon accepts options, not a reason enum',
    'existing.abandon("manual");',
    'const bound: Promise<Outcome<Keiyaku>> = Keiyaku.bind(input);',
    '// @ts-expect-error Repo is not a second contract-construction surface',
    'repo.bind(input);',
    '// @ts-expect-error Receipt was removed from the package-root surface',
    'type Receipt = import("@astrosheep/keiyaku-v4").Receipt;',
    'const report = null as unknown as AuditReport;',
    'const timeline = null as unknown as TimelineEntry;',
    'const kind = null as unknown as FactKind;',
    'const abandonInput = null as unknown as AbandonInput;',
    'const actor = null as unknown as ActorId;',
    'const arcInput = null as unknown as ArcInput;',
    'const auditInput = null as unknown as AuditInput;',
    'const verdict = null as unknown as AttestationVerdict;',
    'const bindResult = null as unknown as BindResult;',
    'const change = null as unknown as ChangeId;',
    'const state = null as unknown as ContractState;',
    'const statusContract = null as unknown as ContractStatus;',
    'const statusInput: StatusInput = { contract: id };',
    'const statusRow: ContractStatus = { contractId: id, phase: "bound", workspace: "here", worktreePath: null, target: null, verification: null };',
    '// @ts-expect-error terminal is derived from phase and is not a status row field',
    'const statusRowWithTerminal: ContractStatus = { contractId: id, phase: "bound", terminal: null, workspace: "here", worktreePath: null, target: null, verification: null };',
    '// @ts-expect-error workspace is a total construction coordinate',
    'const statusRowWithNullWorkspace: ContractStatus = { contractId: id, phase: "bound", workspace: null, worktreePath: null, target: null, verification: null };',
    'const deliverInput = null as unknown as DeliverInput;',
    'const fact = null as unknown as Fact;',
    'const gate = null as unknown as Gate;',
    'const reconcile = null as unknown as ReconcileReport;',
    'const atInput = null as unknown as RepoAtInput;',
    'const repoReconcile = null as unknown as RepoReconcileReport;',
    'const reviewInput = null as unknown as ReviewInput;',
    'const review = null as unknown as Review;',
    'const regionOverlap = null as unknown as RegionOverlap;',
    'const snapshot = null as unknown as SnapshotId;',
    'const status = null as unknown as StatusReport;',
    'const refusal = null as unknown as TypedRefusal;',
    'const retry = null as unknown as TypedRetry;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAbandonData = import("@astrosheep/keiyaku-v4").AbandonData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAbandonedData = import("@astrosheep/keiyaku-v4").AbandonedData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAttestationData = import("@astrosheep/keiyaku-v4").AttestationData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalAmendData = import("@astrosheep/keiyaku-v4").AmendData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalBindData = import("@astrosheep/keiyaku-v4").BindData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalBoundData = import("@astrosheep/keiyaku-v4").BoundData;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalClaimedData = import("@astrosheep/keiyaku-v4").ClaimedData;',
    '// @ts-expect-error internal journal coordinate is not a package-root export',
    'type InternalCoordinates = import("@astrosheep/keiyaku-v4").ContractCoordinates;',
    '// @ts-expect-error internal journal body part is not a package-root export',
    'type InternalCriterion = import("@astrosheep/keiyaku-v4").ContractCriterion;',
    '// @ts-expect-error internal journal body part is not a package-root export',
    'type InternalExtension = import("@astrosheep/keiyaku-v4").ContractExtension;',
    '// @ts-expect-error internal journal alias is not a package-root export',
    'type InternalHead = import("@astrosheep/keiyaku-v4").ContractHead;',
    '// @ts-expect-error internal journal data is not a package-root export',
    'type InternalDeliverData = import("@astrosheep/keiyaku-v4").DeliverData;',
    '// @ts-expect-error internal journal identity is not a package-root export',
    'type InternalEntryUlid = import("@astrosheep/keiyaku-v4").EntryUlid;',
    '// @ts-expect-error internal input helper is not a package-root export',
    'type InternalActorOptions = import("@astrosheep/keiyaku-v4").ActorOptions;',
    '// @ts-expect-error internal subject identity is not a package-root export',
    'type InternalSubject = import("@astrosheep/keiyaku-v4").SubjectKey;',
    '// @ts-expect-error internal verification data is not a package-root export',
    'type InternalVerification = import("@astrosheep/keiyaku-v4").VerificationDeclaration;',
    '// @ts-expect-error internal verification data is not a package-root export',
    'type InternalExecutor = import("@astrosheep/keiyaku-v4").VerificationExecutor;',
    '// @ts-expect-error internal verification refusal has no separate package-root name',
    'type InternalVerificationRefusal = import("@astrosheep/keiyaku-v4").VerificationDeclarationRefusal;',
    '// @ts-expect-error legacy ReviewResult alias is not a package-root export',
    'type InternalReviewResult = import("@astrosheep/keiyaku-v4").ReviewResult;',
    '// @ts-expect-error legacy ReviewValue alias is not a package-root export',
    'type InternalReviewValue = import("@astrosheep/keiyaku-v4").ReviewValue;',
    '// @ts-expect-error legacy DeliverValue alias is not a package-root export',
    'type InternalDeliverValue = import("@astrosheep/keiyaku-v4").DeliverValue;',
    'void new AuthorityCorruptionError("corrupt"); void existing; void delivery; void bound; void repo; void report; void timeline; void kind; void amendment; void invalidBind; void invalidAmend; void invalidGate; void abandonInput; void actor; void arcInput; void auditInput; void verdict; void bindResult; void change; void state; void statusContract; void statusInput; void statusRow; void statusRowWithTerminal; void statusRowWithNullWorkspace; void deliverInput; void fact; void gate; void reconcile; void atInput; void repoReconcile; void reviewInput; void review; void regionOverlap; void snapshot; void status; void refusal; void retry;',
  ].join("\n");
  writeFileSync(join(directory, "consumer.ts"), source);
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "consumer.ts"], { cwd: directory, stdio: "ignore" });
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("@astrosheep/keiyaku-v4"); console.log(Object.keys(m).sort().join(","));'], { cwd: directory, encoding: "utf8" });
  assert.equal(output.trim(), "AuthorityCorruptionError,Delivery,Keiyaku,Repo");
});

test("package exports reject deep internal imports", () => {
  const directory = externalConsumer();
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", 'await import("@astrosheep/keiyaku-v4/build/src/core/facts/types.js")'], { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }),
    (error: unknown) => {
      const value = error as { stderr?: Buffer };
      return value.stderr?.toString("utf8").includes("ERR_PACKAGE_PATH_NOT_EXPORTED") === true;
    },
  );
});

test("task package export exposes only the Tasks-first native surface", () => {
  const directory = externalConsumer();
  const source = [
    'import { Tasks, type Task, type TaskId, type TaskMutationResult } from "@astrosheep/keiyaku-v4/task";',
    'const tasks = Tasks.at({ path: "." });',
    'const task: Task = tasks.task({ id: "task/example" });',
    'const id: TaskId = task.id;',
    'const result: Promise<TaskMutationResult> = tasks.add({ title: "Example", state: "in_progress" });',
    '// @ts-expect-error Task has no static construction surface',
    'Task.at({ path: "." });',
    '// @ts-expect-error callers do not choose IDs during creation',
    'tasks.add({ id: "task/chosen", title: "Chosen" });',
    'void tasks; void task; void id; void result;',
  ].join("\n");
  writeFileSync(join(directory, "consumer-task.ts"), source);
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "consumer-task.ts"], { cwd: directory, stdio: "ignore" });
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("@astrosheep/keiyaku-v4/task"); console.log(Object.keys(m).sort().join(","));'], { cwd: directory, encoding: "utf8" });
  assert.equal(output.trim(), "TaskAuthorityCorruptionError,Tasks");
});

test("built CLI bin keeps its shebang and executes through an installed-style symlink", () => {
  const repository = repositoryWithInitialCommit();
  const bin = join(root, "build", "src", "cli", "index.js");
  const linkDirectory = mkdtempSync(join(tmpdir(), "keiyaku-v4-bin-"));
  const link = join(linkDirectory, "keiyaku-v4");
  assert.equal(readFileSync(bin, "utf8").split("\n", 1)[0], "#!/usr/bin/env node");
  chmodSync(bin, 0o755);
  symlinkSync(bin, link);
  const output = execFileSync(link, ["status", "--json"], { cwd: repository.path, encoding: "utf8" });
  assert.equal(JSON.parse(output).kind, "observation");
});

test("Keiyaku owns contract construction over one pinned Repo capability", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = Repo.at({ path: repository.path });
  assert.deepEqual(Object.getOwnPropertyNames(Keiyaku).filter((name) => !["length", "name", "prototype"].includes(name)).sort(), ["bind", "of"]);
  assert.deepEqual(Object.getOwnPropertyNames(Delivery).filter((name) => !["length", "name", "prototype"].includes(name)), []);
  assert.deepEqual(Object.getOwnPropertyNames(Repo).filter((name) => !["length", "name", "prototype"].includes(name)), ["at"]);
  assert.deepEqual(Object.getOwnPropertyNames(Repo.prototype).filter((name) => name !== "constructor").sort(), ["reconcile", "status"]);
  await assert.rejects(
    Keiyaku.bind({ repo,
      markdown: markdown("Invalid gate"),
      workspace: "here",
      gates: ["reviewed", "edge-owned"] as never,
    }),
    (error: unknown) => error instanceof TypeError && error.message === "gates[1] must be reviewed or verified",
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
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return a contract");
  const state = await bound.value.state();
  assert.equal(state.id, "kei/markdown-input");
  assert.equal(state.terms.document.bytes, markdown("Markdown input"));
  assert.deepEqual(state.terms.after, []);
  assert.deepEqual(state.terms.gates, []);

  const sameTitle = await Keiyaku.bind({ repo, markdown: markdown("Markdown input"), workspace: "here" });
  assert.equal(sameTitle.kind, "accepted");
  if (sameTitle.kind !== "accepted") throw new Error("colliding bind did not return a contract");
  assert.match((await sameTitle.value.state()).id, /^kei\/markdown-input-[0-9a-hjkmnp-tv-z]{8}$/);

  assert.equal(repo.root, resolve(repo.root));
  assert.equal((await repo.status()).contracts.some((contract) => contract.contractId === state.id), true);
  assert.deepEqual(await Keiyaku.of({ repo, id: "kei/missing" as ContractId }).amend({
    markdown: "## Append: Context\nmissing\n",
  }), {
    kind: "refused",
    refusal: { kind: "contract-missing", contractId: "kei/missing" },
  });
});

test("public handle values are type tokens, not alternate constructors", () => {
  assert.throws(() => Reflect.construct(Keiyaku as unknown as Function, []), TypeError);
  assert.throws(() => Reflect.construct(Delivery as unknown as Function, []), TypeError);
});

test("bind canonicalizes branch targets and refuses invalid names before birth", async () => {
  const repository = repositoryWithInitialCommit();
  const repo = Repo.at({ path: repository.path });
  const bound = await Keiyaku.bind({ repo, markdown: markdown("Short target"), target: "main", workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("short target was not accepted");
  assert.equal((await bound.value.state()).coordinates.target, "refs/heads/main");

  const carrierBefore = repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim();
  for (const target of ["bad..name", "keiyaku-state", "refs/tags/main"]) {
    assert.deepEqual(await Keiyaku.bind({ repo, markdown: markdown("Invalid target"), target, workspace: "here" }), {
      kind: "refused",
      refusal: { kind: "invalid-target" },
    });
    assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), carrierBefore);
  }

  assert.deepEqual(await Keiyaku.bind({ repo, markdown: markdown("Missing target"), target: "missing", workspace: "here" }), {
    kind: "refused",
    refusal: { kind: "target-missing" },
  });
  assert.equal(repository.run(["rev-parse", "refs/heads/keiyaku-state"]).trim(), carrierBefore);
  assert.equal(repository.run(["for-each-ref", "--format=%(refname)", "refs/heads/missing"]), "");
});

test("public amend rejects a transitive prerequisite cycle without moving its head", async () => {
  const repo = Repo.at({ path: repositoryWithInitialCommit().path });
  const prerequisite = await Keiyaku.bind({ repo, markdown: markdown("Prerequisite"), workspace: "here" });
  assert.equal(prerequisite.kind, "accepted");
  if (prerequisite.kind !== "accepted") throw new Error("prerequisite bind was not accepted");
  const prerequisiteId = (await prerequisite.value.state()).id;

  const amended = await Keiyaku.bind({ repo,
    markdown: markdown("Amended"),
    workspace: "here",
    after: [prerequisiteId],
  });
  assert.equal(amended.kind, "accepted");
  if (amended.kind !== "accepted") throw new Error("amended contract bind was not accepted");
  const amendedId = (await amended.value.state()).id;

  const dependent = await Keiyaku.bind({ repo,
    markdown: markdown("Dependent"),
    workspace: "here",
    after: [amendedId],
  });
  assert.equal(dependent.kind, "accepted");
  if (dependent.kind !== "accepted") throw new Error("dependent bind was not accepted");
  const dependentId = (await dependent.value.state()).id;
  const head = (await amended.value.state()).head;

  assert.deepEqual(await amended.value.amend({
    markdown: "## Append: Context\ncycle\n",
    after: [dependentId],
  }), {
    kind: "refused",
    refusal: { kind: "cyclic-prerequisite", contractId: amendedId },
  });
  assert.equal((await amended.value.state()).head, head);
});

test("amend applies Markdown once and preserves structured values unless replaced", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: markdown("Amend input"), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return a contract");

  await assert.rejects(
    bound.value.amend({
      markdown: "## Append: Context\ninvalid gate\n",
      gates: ["edge-owned"] as never,
    }),
    (error: unknown) => error instanceof TypeError && error.message === "gates[0] must be reviewed or verified",
  );

  const verified = await bound.value.amend({
    markdown: ["## Replace: Verification", "~~~bash", "exit 0", "~~~", ""].join("\n"),
    gates: ["verified"],
  });
  assert.equal(verified.kind, "accepted");
  const beforePreserved = await bound.value.state();
  assert.deepEqual(beforePreserved.terms.gates, ["verified"]);

  const preserved = await bound.value.amend({
    markdown: ["## Append: Context", "more context", ""].join("\n"),
    after: [],
  });
  assert.equal(preserved.kind, "accepted");
  if (preserved.kind !== "accepted") throw new Error("amend was not accepted");
  const state = await bound.value.state();
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
  const repo = Repo.at({ path: repository.path });
  const here = await Keiyaku.bind({ repo, markdown: markdown("Arc input"), workspace: "here" });
  assert.equal(here.kind, "accepted");
  if (here.kind !== "accepted") throw new Error("bind did not return a contract");
  const arc = await here.value.arc({
    markdown: ["# Chapter", "", "## Objective", "advance", "", "## Brief", "dispatch", ""].join("\n"),
  });
  assert.equal(arc.kind, "accepted");
  assert.equal((await here.value.state()).currentArc?.data.seq, 1);

  const managed = await Keiyaku.bind({ repo, markdown: markdown("Managed"), workspace: "worktree" });
  assert.equal(managed.kind, "accepted");
  if (managed.kind !== "accepted") throw new Error("bind did not return a contract");
  const status = await repo.status();
  const managedState = await managed.value.state();
  assert.equal(typeof status.contracts.find((contract) => contract.contractId === managedState.id)?.worktreePath, "string");
});

test("Delivery.diff remains a nullable Promise-backed transport read", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ repo: Repo.at({ path: repository.path }), markdown: markdown("Diff input"), workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return a contract");
  writeFileSync(join(repository.path, "candidate.txt"), "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  if (delivered.kind !== "accepted") throw new Error("deliver did not return a delivery");
  const diff = await delivered.value.diff();
  assert.equal(typeof diff, "string");
  assert.match(diff, /candidate\.txt/);
});
