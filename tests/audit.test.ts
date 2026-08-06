import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { Keiyaku } from "../src/index.js";
import { repositoryAt } from "../src/carrier/repository.js";
import type { JournalEntry } from "../src/core/facts/types.js";
import { verifyStoredDelivery } from "../src/protocol/intent.js";
import { auditReport, type AuditReport } from "../src/protocol/read/audit.js";
import type { VerificationOutcome } from "../src/verification/producer.js";
import { makeGitRepository, type TestGitRepository } from "./support/git.js";

function journalEntry(kind: JournalEntry["kind"], at: string): JournalEntry {
  return { kind, at } as JournalEntry;
}

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function verificationBody(): string {
  return [
    "# Audit",
    "",
    "## Context",
    "Exercise the audit reader.",
    "",
    "## Objective",
    "Keep reports derived and compact.",
    "",
    "## Design",
    "Run the stored Verification.",
    "",
    "## Region",
    "~~~",
    "src/**",
    "~~~",
    "",
    "## Criteria",
    "### Audit",
    "The report follows the journal.",
    "",
    "## Verification",
    "~~~bash",
    "exit 1",
    "~~~",
    "",
  ].join("\n");
}

function failureOutcome(failure: NonNullable<AuditReport["attempt"]>["failure"]): VerificationOutcome {
  const step = { declaration: { executor: "bash" as const, script: "exit 1" }, argv: ["bash", "-c", "exit 1"] };
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), stdoutTruncated: false, stderrTruncated: false, durationMs: 0 };
  switch (failure) {
    case "timeout":
      return { declarationKey: "a".repeat(64), plan: [step], kind: "timeout", execution: { step, outcome: { kind: "timeout", reason: "timeout", ...output } } };
    case "spawn-error":
      return { declarationKey: "a".repeat(64), plan: [step], kind: "spawn-error", execution: { step, outcome: { kind: "spawn-error", error: new Error("unavailable"), ...output } } };
    case "unknown-exit":
      return { declarationKey: "a".repeat(64), plan: [step], kind: "unknown-exit", execution: { step, outcome: { kind: "exit", code: null, signal: "SIGTERM", ...output } } };
  }
}

async function failedStoredVerification(): Promise<Readonly<{
  repository: TestGitRepository;
  contract: Keiyaku;
  state: Awaited<ReturnType<Keiyaku["state"]>>;
}>> {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({ markdown: verificationBody(), repo: repository.path, workspace: "here" });
  assert.equal(bound.kind, "accepted");
  if (bound.kind !== "accepted") throw new Error("bind was not accepted");
  writeFileSync(`${repository.path}/candidate.txt`, "candidate\n");
  repository.run(["add", "candidate.txt"]);
  repository.run(["commit", "--quiet", "-m", "candidate"]);
  const delivered = await bound.value.deliver();
  assert.equal(delivered.kind, "accepted");
  const state = await bound.value.state();
  assert.equal(state.verifications.at(-1)?.data.result, "fail");
  return { repository, contract: bound.value, state };
}

test("audit report counts every entry and preserves exact valid, invalid, and negative timeline intervals", () => {
  const report = auditReport([
    journalEntry("bind", "2026-08-06T00:00:10.000Z"),
    journalEntry("deliver", "2026-08-06T00:00:09.000Z"),
    journalEntry("review", "not-a-time"),
    journalEntry("arc", "2026-08-06T00:00:20.000Z"),
    journalEntry("deliver", "2026-08-06T00:00:21.250Z"),
    journalEntry("review", "2026-08-06T00:00:21.250Z"),
  ]);

  assert.deepEqual(report, {
    reworks: 2,
    reviews: 2,
    timeline: [
      { kind: "bind", at: "2026-08-06T00:00:10.000Z", sincePrior: null },
      { kind: "deliver", at: "2026-08-06T00:00:09.000Z", sincePrior: -1_000 },
      { kind: "review", at: "not-a-time", sincePrior: null },
      { kind: "arc", at: "2026-08-06T00:00:20.000Z", sincePrior: null },
      { kind: "deliver", at: "2026-08-06T00:00:21.250Z", sincePrior: 1_250 },
      { kind: "review", at: "2026-08-06T00:00:21.250Z", sincePrior: 0 },
    ],
  });
});

test("audit report carries each non-persisted Verification failure value only as an attempt", () => {
  for (const failure of ["timeout", "spawn-error", "unknown-exit"] as const) {
    assert.deepEqual(auditReport([], { failure }), {
      reworks: 0,
      reviews: 0,
      timeline: [],
      attempt: { failure },
    });
  }
});

test("stored Verification maps every nonterminal producer outcome to an audit attempt without admission", async () => {
  for (const failure of ["timeout", "spawn-error", "unknown-exit"] as const) {
    const { repository, contract, state } = await failedStoredVerification();
    const before = state.verifications.length;
    const result = await verifyStoredDelivery({
      repository: repositoryAt(repository.path),
      contractId: state.id,
      at: "2026-08-06T00:00:00.000Z",
      state,
      environment: {},
      produce: async () => failureOutcome(failure),
    });
    assert.deepEqual(result, { failure });
    assert.equal((await contract.state()).verifications.length, before);
  }
});
