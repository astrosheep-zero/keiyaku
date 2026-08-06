import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ContractBody, Delivery, Keiyaku, Repo, type ContractId } from "../src/index.js";
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
    'import { ContractBody, Delivery, Keiyaku, Repo, type AbandonInput, type ActorId, type AmendInput, type ArcChapter, type ArcInput, type AuditInput, type AuditReport, type AttestationVerdict, type BindInput, type BindResult, type ChangeId, type ContractBody as Body, type ContractBodyRenderInput, type ContractId, type ContractState, type ContractStatus, type DeliverInput, type Fact, type FactKind, type Gate, type KeiyakuOfInput, type Outcome, type Receipt, type ReconcileReport, type RepoAtInput, type RepoReconcileReport, type ReviewInput, type SnapshotId, type StatusReport, type TimelineEntry, type TypedRefusal, type TypedRetry } from "@astrosheep/keiyaku-v4";',
    'const id = "kei/consumer" as ContractId;',
    'const input: BindInput = { markdown: "# T\\n\\n## Context\\nC\\n\\n## Objective\\nO\\n\\n## Design\\nD\\n\\n## Region\\n~~~\\nsrc/**\\n~~~\\n\\n## Criteria\\n### C1\\nB\\n", repo: ".", after: [id] };',
    'const amendment: AmendInput = { markdown: "## Append: Context\\nMore\\n", after: [id] };',
    'const body = null as unknown as Body;',
    'const rendered = ContractBody.render({ body });',
    'const existing = Keiyaku.of({ id, repo: "." });',
    'const delivery = null as unknown as Delivery;',
    '// @ts-expect-error ContractBody.render accepts one input object',
    'ContractBody.render(body);',
    '// @ts-expect-error Keiyaku.of accepts one input object',
    'Keiyaku.of(id);',
    '// @ts-expect-error Repo.at accepts one input object',
    'Repo.at(".");',
    '// @ts-expect-error Delivery.review accepts one input object',
    'delivery.review("satisfied");',
    '// @ts-expect-error Delivery has no public constructor',
    'new Delivery();',
    '// @ts-expect-error Keiyaku.of requires a branded ContractId',
    'Keiyaku.of("kei/unbranded");',
    '// @ts-expect-error BindInput.after requires branded ContractId values',
    'const invalidBind: BindInput = { ...input, after: ["kei/unbranded"] };',
    '// @ts-expect-error AmendInput.after requires branded ContractId values',
    'const invalidAmend: AmendInput = { ...amendment, after: ["kei/unbranded"] };',
    '// @ts-expect-error abandon accepts options, not a reason enum',
    'existing.abandon("manual");',
    'const bound: Promise<Outcome<Keiyaku>> = Keiyaku.bind(input);',
    'const repo = Repo.at({ path: "." });',
    'const receipt = null as unknown as Receipt;',
    'const report = null as unknown as AuditReport;',
    'const timeline = null as unknown as TimelineEntry;',
    'const kind = null as unknown as FactKind;',
    'const abandonInput = null as unknown as AbandonInput;',
    'const actor = null as unknown as ActorId;',
    'const chapter = null as unknown as ArcChapter;',
    'const arcInput = null as unknown as ArcInput;',
    'const auditInput = null as unknown as AuditInput;',
    'const verdict = null as unknown as AttestationVerdict;',
    'const bindResult = null as unknown as BindResult;',
    'const change = null as unknown as ChangeId;',
    'const renderInput = null as unknown as ContractBodyRenderInput;',
    'const state = null as unknown as ContractState;',
    'const statusContract = null as unknown as ContractStatus;',
    'const deliverInput = null as unknown as DeliverInput;',
    'const fact = null as unknown as Fact;',
    'const gate = null as unknown as Gate;',
    'const ofInput = null as unknown as KeiyakuOfInput;',
    'const reconcile = null as unknown as ReconcileReport;',
    'const atInput = null as unknown as RepoAtInput;',
    'const repoReconcile = null as unknown as RepoReconcileReport;',
    'const reviewInput = null as unknown as ReviewInput;',
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
    'void rendered; void existing; void delivery; void bound; void repo; void receipt; void report; void timeline; void kind; void amendment; void invalidBind; void invalidAmend; void abandonInput; void actor; void chapter; void arcInput; void auditInput; void verdict; void bindResult; void change; void renderInput; void state; void statusContract; void deliverInput; void fact; void gate; void ofInput; void reconcile; void atInput; void repoReconcile; void reviewInput; void snapshot; void status; void refusal; void retry;',
  ].join("\n");
  writeFileSync(join(directory, "consumer.ts"), source);
  execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", "consumer.ts"], { cwd: directory, stdio: "ignore" });
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", 'const m = await import("@astrosheep/keiyaku-v4"); console.log(Object.keys(m).sort().join(","));'], { cwd: directory, encoding: "utf8" });
  assert.equal(output.trim(), "ContractBody,Delivery,Keiyaku,Repo");
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

test("ContractBody exposes canonical rendering and no public decoders", async () => {
  assert.deepEqual(Object.keys(ContractBody), ["render"]);
  assert.equal("parse" in ContractBody, false);
  assert.equal("amend" in ContractBody, false);

  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ markdown: markdown(), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return a contract");
  const state = await bound.value.state();
  if (state.body === null) throw new Error("bound body is absent");
  assert.match(ContractBody.render({ body: state.body }), /^# Boundary\n/);
});

test("Keiyaku construction is Markdown-in and Repo has only world reads", async () => {
  const repository = repositoryWithInitialCommit();
  assert.deepEqual(Object.getOwnPropertyNames(Keiyaku).filter((name) => !["length", "name", "prototype"].includes(name)).sort(), ["bind", "of"]);
  assert.deepEqual(Object.getOwnPropertyNames(Delivery).filter((name) => !["length", "name", "prototype"].includes(name)), []);
  assert.deepEqual(Object.getOwnPropertyNames(Repo).filter((name) => !["length", "name", "prototype"].includes(name)), ["at"]);
  assert.deepEqual(Object.getOwnPropertyNames(Repo.prototype).filter((name) => name !== "constructor").sort(), ["reconcile", "status"]);

  const bound = await Keiyaku.bind({
    markdown: markdown("Markdown input"),
    repo: repository.path,
    workspace: "here",
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return a contract");
  const state = await bound.value.state();
  assert.equal(state.body?.title, "Markdown input");
  assert.deepEqual(state.body?.after, []);
  assert.deepEqual(state.body?.gates, ["reviewed"]);
  assert.equal(bound.value.worktreePath, null);

  const repo = Repo.at({ path: repository.path });
  assert.equal(repo.root, resolve(repo.root));
  assert.equal((await repo.status()).contracts.some((contract) => contract.contractId === state.id), true);
  assert.equal(Keiyaku.of({ id: state.id, repo: repository.path }).worktreePath, null);
  assert.deepEqual(await Keiyaku.of({ id: "kei/missing" as ContractId, repo: repository.path }).amend({
    markdown: "## Append: Context\nmissing\n",
  }), {
    kind: "refused",
    refusal: { kind: "contract-missing", contractId: "kei/missing" },
  });
});

test("amend applies Markdown once and preserves structured values unless replaced", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ markdown: markdown("Amend input"), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return a contract");

  const verified = await bound.value.amend({
    markdown: ["## Replace: Verification", "~~~bash", "exit 0", "~~~", ""].join("\n"),
    gates: [],
  });
  assert.equal(verified.kind, "accepted");
  assert.deepEqual((await bound.value.state()).body?.gates, ["verified"]);

  const preserved = await bound.value.amend({
    markdown: ["## Append: Context", "more context", ""].join("\n"),
    after: [],
  });
  assert.equal(preserved.kind, "accepted");
  const state = await bound.value.state();
  assert.deepEqual(state.body?.after, []);
  assert.deepEqual(state.body?.gates, ["verified"]);
  assert.equal(state.body?.context, "context\n\nmore context\n");
});

test("arc decodes its Markdown input and worktree paths are computed", async () => {
  const repository = repositoryWithInitialCommit();
  const here = await Keiyaku.bind({ markdown: markdown("Arc input"), repo: repository.path, workspace: "here" });
  assert.equal(here.kind, "accepted");
  if (here.kind !== "accepted") throw new Error("bind did not return a contract");
  const arc = await here.value.arc({
    markdown: ["# Chapter", "", "## Objective", "advance", "", "## Brief", "dispatch", ""].join("\n"),
  });
  assert.equal(arc.kind, "accepted");
  assert.equal((await here.value.state()).currentArc?.data.seq, 1);

  const managed = await Keiyaku.bind({ markdown: markdown("Managed"), repo: repository.path, workspace: "worktree" });
  assert.equal(managed.kind, "accepted");
  if (managed.kind !== "accepted") throw new Error("bind did not return a contract");
  const path = managed.value.worktreePath;
  assert.equal(typeof path, "string");
  const status = await Repo.at({ path: repository.path }).status();
  const managedState = await managed.value.state();
  assert.equal(status.contracts.find((contract) => contract.contractId === managedState.id)?.worktreePath, path);
});

test("Delivery.diff remains a nullable Promise-backed transport read", async () => {
  const repository = repositoryWithInitialCommit();
  const bound = await Keiyaku.bind({ markdown: markdown("Diff input"), repo: repository.path, workspace: "here" });
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
