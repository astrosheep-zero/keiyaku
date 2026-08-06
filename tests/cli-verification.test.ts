import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { observeContract } from "../src/carrier/observe.js";
import { repositoryAt } from "../src/carrier/repository.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { makeGitRepository } from "./support/git.js";

function repositoryWithCandidate() {
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
  raw.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const target = raw.run(["rev-parse", "HEAD"]).trim();
  raw.run(["checkout", "--quiet", "-b", "feature"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "candidate"]);
  const candidate = raw.run(["rev-parse", "HEAD"]).trim();
  return { raw, repository: repositoryAt(raw.path), target, candidate };
}

function document(script?: string): string {
  return [
    "# CLI Verification",
    "",
    "## Context",
    "Facts.",
    "",
    "## Objective",
    "Verify.",
    "",
    "## Design",
    "Run.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Check",
    "The check runs.",
    ...(script === undefined ? [] : ["", "## Verification", "```bash", script, "```"]),
    "",
  ].join("\n");
}

async function bindAndDeliver(script?: string, gates: readonly string[] = []) {
  const setup = repositoryWithCandidate();
  mkdirSync(resolve(setup.raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(setup.raw.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: gates } }));
  const bound = await invoke(parseArgv([
    "bind", "--target", "refs/heads/main", "--here", "--actor", "external-test", "-",
  ]), {
    cwd: setup.raw.path,
    environment: {},
    readStdin: () => document(script),
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return an accepted contract");
  const result = await invoke(parseArgv(["deliver", bound.contract, "--actor", "external-test"]), {
    cwd: setup.raw.path,
    environment: {},
  });
  return { ...setup, id: bound.contract, result };
}

test("deliver adapts a passing Verification through the package-root operation", async () => {
  const { raw, repository, id, candidate, result } = await bindAndDeliver("exit 0");
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["deliver", "verification", "claimed"]);
  assert.equal(observeContract(repository, id).state?.terminal?.kind, "claimed");
  assert.equal(raw.run(["rev-parse", "refs/heads/main"]).trim(), candidate);
});

test("deliver adapts a failing Verification without a private producer injection", async () => {
  const { repository, id, result } = await bindAndDeliver("exit 1");
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["deliver", "verification"]);
  assert.equal(observeContract(repository, id).state?.terminal, null);
  assert.equal(observeContract(repository, id).state?.verifications.at(-1)?.data.result, "fail");
});

test("deliver verifies the admitted candidate rather than dirty --here bytes and cleans up", async () => {
  const setup = repositoryWithCandidate();
  writeFileSync(resolve(setup.raw.path, "candidate.txt"), "failing\n");
  setup.raw.run(["add", "candidate.txt"]);
  setup.raw.run(["commit", "--quiet", "-m", "failing candidate"]);
  mkdirSync(resolve(setup.raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(setup.raw.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: [] } }));

  const bound = await invoke(parseArgv([
    "bind", "--target", "refs/heads/main", "--here", "--actor", "external-test", "-",
  ]), {
    cwd: setup.raw.path,
    environment: {},
    readStdin: () => document('test "$(cat candidate.txt)" = "passing"'),
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") return;

  writeFileSync(resolve(setup.raw.path, "candidate.txt"), "passing\n");
  const worktreesBefore = setup.raw.run(["worktree", "list", "--porcelain"]);
  const result = await invoke(parseArgv(["deliver", bound.contract, "--actor", "external-test"]), {
    cwd: setup.raw.path,
    environment: {},
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["deliver", "verification"]);
  assert.equal(observeContract(setup.repository, bound.contract).state?.verifications.at(-1)?.data.result, "fail");
  assert.equal(setup.raw.run(["worktree", "list", "--porcelain"]), worktreesBefore);
});

test("audit classifies its public receipt as accepted when it admits a Verification fact", async () => {
  const pending = await bindAndDeliver("exit 1");
  const audit = await invoke(parseArgv(["audit", pending.id, "--show-diff-body", "--actor", "audit-user"]), {
    cwd: pending.raw.path,
    environment: {},
  });
  assert.equal(audit.kind, "accepted");
  if (audit.kind !== "accepted") return;
  assert.deepEqual(audit.facts.map((fact) => fact.kind), ["verification"]);
  assert.equal(audit.report.attempt, undefined);
  assert.equal("diff" in audit, true);
  assert.equal(observeContract(pending.repository, pending.id).state?.verifications.at(-1)?.actor, "audit-user");
});

test("audit renders a pure read as an observation with its public report and optional diff", async () => {
  const complete = await bindAndDeliver("exit 0");
  const plain = await invoke(parseArgv(["audit", complete.id]), {
    cwd: complete.raw.path,
    environment: {},
  });
  assert.equal(plain.kind, "observation");
  if (plain.kind !== "observation") return;
  assert.equal(plain.attempt, undefined);
  assert.equal(plain.reworks, 1);
  assert.equal("diff" in plain, false);

  const detailed = await invoke(parseArgv(["audit", complete.id, "--show-diff-body"]), {
    cwd: complete.raw.path,
    environment: {},
  });
  assert.equal(detailed.kind, "observation");
  if (detailed.kind !== "observation") return;
  assert.equal(detailed.attempt, undefined);
  assert.equal(detailed.reworks, 1);
  assert.equal("diff" in detailed, true);
});

test("audit renders a missing contract as a typed refusal", async () => {
  const repository = repositoryWithCandidate().raw;
  const result = await invoke(parseArgv(["audit", "kei/missing"]), {
    cwd: repository.path,
    environment: {},
  });

  assert.deepEqual(result, {
    kind: "refused",
    verb: "audit",
    contract: "kei/missing",
    refusal: { kind: "contract-missing", contractId: "kei/missing" },
  });
});
