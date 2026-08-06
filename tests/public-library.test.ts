import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { ContractBody, Keiyaku, Repo } from "../src/index.js";
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
    'import { ContractBody, Keiyaku, Repo, type AuditReport, type BindInput, type ContractBody as Body, type ContractId, type FactKind, type Outcome, type Receipt, type TimelineEntry } from "@astrosheep/keiyaku-v4";',
    'const input: BindInput = { markdown: "# T\\n\\n## Context\\nC\\n\\n## Objective\\nO\\n\\n## Design\\nD\\n\\n## Region\\n~~~\\nsrc/**\\n~~~\\n\\n## Criteria\\n### C1\\nB\\n", repo: "." };',
    'const body = null as unknown as Body;',
    'const rendered = ContractBody.render(body);',
    'const existing = Keiyaku.of("kei/consumer" as ContractId, { repo: "." });',
    'const bound: Promise<Outcome<Keiyaku>> = Keiyaku.bind(input);',
    'const repo = Repo.at(".");',
    'const receipt = null as unknown as Receipt;',
    'const report = null as unknown as AuditReport;',
    'const timeline = null as unknown as TimelineEntry;',
    'const kind = null as unknown as FactKind;',
    'void rendered; void existing; void bound; void repo; void receipt; void report; void timeline; void kind;',
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
  assert.match(ContractBody.render(state.body), /^# Boundary\n/);
});

test("Keiyaku construction is Markdown-in and Repo has only world reads", async () => {
  const repository = repositoryWithInitialCommit();
  assert.deepEqual(Object.getOwnPropertyNames(Keiyaku).filter((name) => !["length", "name", "prototype"].includes(name)).sort(), ["bind", "of"]);
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

  const repo = Repo.at(repository.path);
  assert.equal(repo.root, resolve(repo.root));
  assert.equal((await repo.status()).contracts.some((contract) => contract.contractId === state.id), true);
  assert.equal(Keiyaku.of(state.id, { repo: repository.path }).worktreePath, null);
  assert.deepEqual(await Keiyaku.of("kei/missing", { repo: repository.path }).amend({
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
  const status = await Repo.at(repository.path).status();
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
