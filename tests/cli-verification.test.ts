import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { repositoryAt } from "../src/git/repository.js";
import { invoke } from "../src/cli/invoke.js";
import { parseArgv } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import { makeGitRepository, observeContract, withGitShim } from "./support/git.js";

async function repositoryWithCandidate() {
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
  raw.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  const target = raw.run(["rev-parse", "HEAD"]).trim();
  raw.run(["checkout", "--quiet", "-b", "feature"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "candidate"]);
  const candidate = raw.run(["rev-parse", "HEAD"]).trim();
  return { raw, repository: await repositoryAt(raw.path), target, candidate };
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

async function bindAndDeliver(script?: string, gates: readonly string[] = ["verified"]) {
  const setup = await repositoryWithCandidate();
  mkdirSync(resolve(setup.raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(setup.raw.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: gates } }));
  const bound = await invoke(parseArgv([
    "bind", "--target", "refs/heads/main", "--actor", "external-test", "-",
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
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
  assert.notEqual(raw.run(["rev-parse", "refs/heads/main"]).trim(), candidate);
});

test("Verification produces an attestation without becoming a placement gate", async () => {
  const { repository, id, result } = await bindAndDeliver("exit 1", []);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  const state = (await observeContract(repository, id)).state;
  assert.deepEqual(state?.terms?.gates, []);
  assert.equal(state?.attestations.at(-1)?.data.gate, "verified");
  assert.equal(state?.attestations.at(-1)?.data.verdict, "unsatisfied");
  assert.equal(state?.terminal?.kind, "claimed");
});

test("deliver adapts a failing Verification without a private producer injection", async () => {
  const { repository, id, result } = await bindAndDeliver("exit 1");
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation"]);
  assert.equal((await observeContract(repository, id)).state?.terminal, null);
  assert.equal((await observeContract(repository, id)).state?.attestations.at(-1)?.data.verdict, "unsatisfied");
});

test("dirty --here delivery materializes and lands the verified candidate cleanly", async () => {
  const setup = await repositoryWithCandidate();
  setup.raw.run(["checkout", "--quiet", "main"]);
  writeFileSync(resolve(setup.raw.path, "candidate.txt"), "failing\n");
  setup.raw.run(["add", "candidate.txt"]);
  setup.raw.run(["commit", "--quiet", "-m", "failing candidate"]);
  mkdirSync(resolve(setup.raw.path, ".keiyaku"), { recursive: true });
  writeFileSync(resolve(setup.raw.path, ".keiyaku", "settings.json"), JSON.stringify({ gates: { default: ["verified"] } }));

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
  const worktreePathsBefore = setup.raw.run(["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  const indexBefore = setup.raw.run(["diff", "--cached", "--binary"]);
  const result = await invoke(parseArgv([
    "deliver", bound.contract, "--include-dirty", "--actor", "external-test", "--message", "Verified dirty candidate",
  ]), {
    cwd: setup.raw.path,
    environment: {},
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.facts.map((fact) => fact.kind), ["bound", "deliver", "attestation", "claimed"]);
  const state = (await observeContract(setup.repository, bound.contract)).state;
  assert.equal(state?.attestations.at(-1)?.data.verdict, "satisfied");
  assert.equal(state?.delivery?.data.integration.snapshot, setup.raw.run(["rev-parse", "HEAD"]).trim());
  assert.equal(setup.raw.run(["show", `${state?.delivery?.data.integration.snapshot}:candidate.txt`]), "passing\n");
  assert.equal(
    setup.raw.run(["show", "-s", "--format=%B", state?.delivery?.data.integration.snapshot ?? "HEAD"]),
    `Verified dirty candidate\n\nKeiyaku-Contract: ${bound.contract}\n\n`,
  );
  assert.equal(setup.raw.run(["diff", "--cached", "--binary"]), indexBefore);
  assert.deepEqual(
    setup.raw.run(["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((line) => line.startsWith("worktree ")),
    worktreePathsBefore,
  );
});

test("audit stays accepted when it admits a verified attestation", async () => {
  const pending = await bindAndDeliver("exit 1");
  const audit = await invoke(parseArgv(["audit", pending.id, "--show-diff-body", "--actor", "audit-user"]), {
    cwd: pending.raw.path,
    environment: {},
  });
  assert.equal(audit.kind, "accepted");
  if (audit.kind !== "accepted") return;
  assert.deepEqual(audit.facts.map((fact) => fact.kind), ["attestation"]);
  assert.equal(audit.report.attempt, undefined);
  assert.equal("diff" in audit, true);
  assert.equal((await observeContract(pending.repository, pending.id)).state?.attestations.at(-1)?.actor, "audit-user");
});

test("audit renders a pure read as accepted with its public report and optional diff", async () => {
  const complete = await bindAndDeliver(undefined, []);
  const plain = await invoke(parseArgv(["audit", complete.id]), {
    cwd: complete.raw.path,
    environment: {},
  });
  assert.equal(plain.kind, "accepted");
  if (plain.kind !== "accepted") return;
  assert.equal(plain.report?.attempt, undefined);
  assert.equal(plain.report?.reworks, 1);
  assert.equal("diff" in plain, false);

  const detailed = await invoke(parseArgv(["audit", complete.id, "--show-diff-body"]), {
    cwd: complete.raw.path,
    environment: {},
  });
  assert.equal(detailed.kind, "accepted");
  if (detailed.kind !== "accepted") return;
  assert.equal(detailed.report?.attempt, undefined);
  assert.equal(detailed.report?.reworks, 1);
  assert.equal("diff" in detailed, true);
});

test("audit renders transient Verification cleanup leaks after accepted and observation paths", async () => {
  const accepted = await bindAndDeliver("exit 1");
  const cleanupFailure = [
    "if [ \"$1\" = \"worktree\" ] && [ \"$2\" = \"remove\" ]; then",
    "  printf 'forced verification cleanup failure\\n' >&2",
    "  exit 17",
    "fi",
    "exec \"$KEIYAKU_REAL_GIT\" \"$@\"",
  ].join("\n");
  const acceptedAudit = await withGitShim(cleanupFailure, {}, () => invoke(parseArgv(["audit", accepted.id]), {
    cwd: accepted.raw.path,
    environment: {},
  }));

  assert.equal(acceptedAudit.kind, "accepted");
  if (acceptedAudit.kind !== "accepted") return;
  assert.deepEqual(acceptedAudit.facts.map((fact) => fact.kind), ["attestation"]);
  assert.match(acceptedAudit.report?.leak?.diagnostic ?? "", /forced verification cleanup failure/);
  assert.equal(renderText(acceptedAudit, { columns: 400, color: false }).includes(
    `leak worktree ${acceptedAudit.report!.leak!.path} ${acceptedAudit.report!.leak!.diagnostic.trimEnd()}`,
  ), true);
  accepted.raw.run(["worktree", "remove", "--force", acceptedAudit.report!.leak!.path]);

  const observed = await bindAndDeliver("kill -TERM $$");
  const observationAudit = await withGitShim(cleanupFailure, {}, () => invoke(parseArgv(["audit", observed.id]), {
    cwd: observed.raw.path,
    environment: {},
  }));

  assert.equal(observationAudit.kind, "accepted");
  if (observationAudit.kind !== "accepted") return;
  assert.deepEqual(observationAudit.report?.attempt, { failure: "unknown-exit" });
  const leak = observationAudit.report?.leak;
  assert.match(leak?.diagnostic ?? "", /forced verification cleanup failure/);
  const observedText = renderText(observationAudit, { columns: 400, color: false });
  assert.match(observedText, /unknown-exit/);
  assert.equal(observedText.includes(
    `leak worktree ${leak!.path} ${leak!.diagnostic.trimEnd()}`,
  ), true);
  observed.raw.run(["worktree", "remove", "--force", leak!.path]);
});

test("audit renders a missing contract as a typed refusal", async () => {
  const repository = (await repositoryWithCandidate()).raw;
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
