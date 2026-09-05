import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { repositoryAt } from "../src/git/repository.js";
import { invoke as invokeRaw, type InvocationResult } from "../src/cli/invoke.js";
import { parseArgv as parseInvocation } from "../src/cli/parse.js";
import { renderText } from "../src/cli/render/text.js";
import { readManagedWorktreeAppointment } from "../src/workspace-place.js";
import { makeGitRepository, observeContract, withGitShim } from "./support/git.js";

function parseArgv(argv: readonly string[]) {
  const parsed = parseInvocation(argv);
  if ("help" in parsed) throw new Error("expected executable command");
  return parsed;
}

async function invoke(
  invocation: Parameters<typeof invokeRaw>[0],
  runtime?: Parameters<typeof invokeRaw>[1],
): Promise<InvocationResult> {
  return (await invokeRaw(invocation, runtime)) as InvocationResult;
}

async function repositoryWithCandidate() {
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
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
  writeFileSync(
    resolve(setup.raw.path, ".keiyaku", "settings.json"),
    JSON.stringify({
      gates: {
        default: { kind: "bundle", gates },
      },
    }),
  );
  const bound = await invoke(parseArgv(["bind", "--target", "refs/heads/main", "--actor", "external-test", "-"]), {
    cwd: setup.raw.path,
    environment: {},
    readStdin: async () => document(script),
  });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind did not return an accepted contract");
  const result = await invoke(parseArgv(["deliver", bound.contract]), {
    cwd: setup.raw.path,
    environment: { KEIYAKU_ACTOR_ID: "external-test" },
  });
  return { ...setup, id: bound.contract, result };
}

test("deliver adapts a passing Verification through the package-root operation", async () => {
  const { raw, repository, id, candidate, result } = await bindAndDeliver("exit 0");
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["bound", "deliver", "attestation", "claimed"],
  );
  assert.equal((await observeContract(repository, id)).state?.terminal?.kind, "claimed");
  assert.notEqual(raw.run(["rev-parse", "refs/heads/main"]).trim(), candidate);
});

test("Verification produces an attestation without becoming a placement gate", async () => {
  const { repository, id, result } = await bindAndDeliver("exit 1", []);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["bound", "deliver", "attestation", "claimed"],
  );
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
  assert.deepEqual(
    result.facts.map((fact) => fact.kind),
    ["bound", "deliver", "attestation"],
  );
  assert.equal((await observeContract(repository, id)).state?.terminal, null);
  assert.equal((await observeContract(repository, id)).state?.attestations.at(-1)?.data.verdict, "unsatisfied");
});

test("audit stays accepted when it admits a verified attestation", async () => {
  const pending = await bindAndDeliver("exit 1");
  const audit = await invoke(parseArgv(["audit", pending.id, "--diff"]), {
    cwd: pending.raw.path,
    environment: { KEIYAKU_ACTOR_ID: "audit-user" },
  });
  assert.equal(audit.kind, "accepted");
  if (audit.kind !== "accepted" || audit.verb !== "audit" || audit.report === undefined)
    assert.fail("expected accepted audit report");
  assert.deepEqual(
    audit.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  assert.equal(audit.report.candidate.kind, "ready");
  assert.equal(audit.report.verification.kind, "unsatisfied");
  if (audit.report.verification.kind === "unsatisfied") {
    assert.equal(audit.report.verification.passed, 0);
    assert.equal(audit.report.verification.total, 1);
  }
  assert.equal(audit.report.target.kind, "placeable");
  assert.equal("diff" in audit, false);
  assert.equal(audit.report.candidate.kind === "ready" ? typeof audit.report.candidate.diff : undefined, "string");
  assert.equal((await observeContract(pending.repository, pending.id)).state?.attestations.at(-1)?.actor, "audit-user");
});

test("audit renders the complete producer-bounded Verification summary as a subordinate payload", async () => {
  const pending = await bindAndDeliver(
    [
      "printf 'stdout one\\nstdout two\\nstdout three\\nstdout four\\n'",
      "printf 'final stderr diagnostic\\n' >&2",
      "exit 1",
    ].join("; "),
  );
  const audit = await invoke(parseArgv(["audit", pending.id]), {
    cwd: pending.raw.path,
    environment: { KEIYAKU_ACTOR_ID: "audit-user" },
  });

  assert.equal(audit.kind, "accepted");
  if (audit.kind !== "accepted" || audit.verb !== "audit" || audit.report === undefined)
    assert.fail("expected accepted audit report");
  assert.equal(audit.report.verification.kind, "unsatisfied");
  if (audit.report.verification.kind !== "unsatisfied") return;
  const summary = audit.report.verification.summary;
  assert.notEqual(summary, undefined);
  if (summary === undefined) return;

  const text = renderText(audit, { columns: 400, color: false });
  const payload = `summary\n\n${summary}\n\n`;
  assert.ok(text.includes(payload) && text.includes("final stderr diagnostic"));
  assert.ok(text.indexOf("✓ candidate") < text.indexOf("! verification"));
  assert.ok(text.indexOf(payload) < text.indexOf("✓ target"));
  if (audit.report.candidate.kind === "ready") {
    const { identity } = audit.report.candidate;
    assert.match(
      text,
      new RegExp(
        `tender commit ${identity.tenderSnapshot}[\\s\\S]*integration commit ${identity.integration.snapshot}[\\s\\S]*content identity \\(not commit\\) ${identity.integration.changeId}`,
      ),
    );
  }
  assert.doesNotMatch(text, new RegExp(audit.head));
});

test("audit refuses a claimed contract before observing its released workspace", async () => {
  const complete = await bindAndDeliver(undefined, []);
  assert.deepEqual(await readManagedWorktreeAppointment(complete.repository, complete.id), { kind: "unappointed" });
  const plain = await invoke(parseArgv(["audit", complete.id]), {
    cwd: complete.raw.path,
    environment: {},
  });
  assert.deepEqual(plain, {
    kind: "refused",
    verb: "audit",
    contract: complete.id,
    refusal: { kind: "terminal", contractId: complete.id },
  });
});

// Timing evidence for the affected test, using the same command on exact snapshots:
// baseline HEAD: real=7.53s user=2.84s sys=1.84s; candidate worktree: real=3.92s user=1.44s sys=0.93s.
test("audit renders transient Verification cleanup leaks after accepted and observation paths", async () => {
  const accepted = await bindAndDeliver("exit 1");
  const cleanupFailure = [
    'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
    "  printf 'forced verification cleanup failure\\n' >&2",
    "  exit 17",
    "fi",
    'exec "$KEIYAKU_REAL_GIT" "$@"',
  ].join("\n");
  const acceptedAudit = await withGitShim(cleanupFailure, {}, (gitPath) =>
    invoke(parseArgv(["audit", accepted.id]), {
      cwd: accepted.raw.path,
      environment: { KEIYAKU_GIT_PATH: gitPath },
    }),
  );

  assert.equal(acceptedAudit.kind, "accepted");
  if (acceptedAudit.kind !== "accepted" || acceptedAudit.verb !== "audit" || acceptedAudit.report === undefined)
    assert.fail("expected accepted audit report");
  assert.deepEqual(
    acceptedAudit.facts.map((fact) => fact.kind),
    ["attestation"],
  );
  const retainedLeak = acceptedAudit.cleanup?.find((item) => item.kind === "worktree-leak")?.leak;
  assert.match(retainedLeak?.diagnostic ?? "", /forced verification cleanup failure/);
  assert.equal("leak" in acceptedAudit.report, false);
  const acceptedText = renderText(acceptedAudit, { columns: 400, color: false });
  assert.equal(acceptedText.includes(retainedLeak!.path), true);
  assert.equal(acceptedText.includes(retainedLeak!.diagnostic.trimEnd()), true);
  accepted.raw.run(["worktree", "remove", "--force", retainedLeak!.path]);

  const observedAudit: Extract<InvocationResult, { kind: "accepted"; verb: "audit" }> = {
    ...acceptedAudit,
    report: {
      ...acceptedAudit.report,
      verification: { kind: "stopped", stop: { failure: "unknown-exit" } },
      target: { kind: "not-observed" },
    },
  };
  assert.equal(observedAudit.report.verification.kind, "stopped");
  if (observedAudit.report.verification.kind === "stopped") {
    if ("failure" in observedAudit.report.verification.stop)
      assert.equal(observedAudit.report.verification.stop.failure, "unknown-exit");
  }
  assert.equal(observedAudit.report.target.kind, "not-observed");
  assert.equal("leak" in observedAudit.report, false);
  const leak = observedAudit.cleanup?.find((item) => item.kind === "worktree-leak")?.leak;
  assert.match(leak?.diagnostic ?? "", /forced verification cleanup failure/);
  const observedText = renderText(observedAudit, { columns: 400, color: false });
  assert.match(observedText, /unknown exit/);
  assert.equal(observedText.includes(leak!.path), true);
  assert.equal(observedText.includes(leak!.diagnostic.trimEnd()), true);
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
