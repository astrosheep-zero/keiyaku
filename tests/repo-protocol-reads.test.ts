import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { deliveryWorktreePath } from "../src/carrier/reconcile.js";
import { contractJournalPath } from "../src/carrier/identity.js";
import { repositoryAt } from "../src/carrier/repository.js";
import { decodeContractDocument } from "../src/body/decode.js";
import {
  bindOperation,
  reconcileAllOperation,
  scopeOperation,
  statusOperation,
} from "../src/protocol/operations.js";
import type { ContractId } from "../src/core/facts/types.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function terms(title: string) {
  const document = decodeContractDocument([
    `# ${title}`,
    "",
    "## Context",
    "Exercise the repository-level protocol reads.",
    "",
    "## Objective",
    "Expose one pinned scope and snapshot-backed status.",
    "",
    "## Design",
    "The protocol owns carrier observation and effects.",
    "",
    "## Region",
    "```",
    "src/**",
    "```",
    "",
    "## Criteria",
    "### Protocol result",
    "The operation returns only plain data.",
    "",
  ].join("\n"));
  return { document: document.document, segments: document.segments, gates: [], after: [] };
}

function bind(repository: TestGitRepository, title: string, workspace: "worktree" | "here"): ContractId {
  const result = bindOperation({
    scope: scopeOperation({ coordinate: repository.path }),
    terms: terms(title),
    verification: { kind: "prepared", data: null },
    workspace,
  });
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") throw new Error("bind did not succeed");
  return result.value.contractId;
}

test("carrier repository resolution rejects omitted and empty coordinates", () => {
  assert.throws(() => Reflect.apply(repositoryAt, undefined, []), /repository path must be a nonempty string/);
  assert.throws(() => repositoryAt(""), /repository path must be a nonempty string/);
});

test("scope and status operations return plain pinned data from one carrier snapshot", () => {
  const repository = repositoryWithMain();
  const first = bind(repository, "First status row", "here");
  const second = bind(repository, "Second status row", "worktree");
  const scope = scopeOperation({ coordinate: repository.path });
  const log = resolve(repository.path, "status-blob-reads.log");
  writeFileSync(log, "");

  const report = withGitShim(
    "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_STATUS_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_STATUS_READ_LOG: log },
    () => statusOperation({ scope }),
  );
  const carrier = repositoryAt(repository.path);

  assert.equal(report.contracts.length, 2);
  assert.equal(scope.effectiveCwd, resolve(repository.path));
  assert.equal(scope.primaryWorktree, carrier.primaryWorktree);
  assert.equal(carrier.effectiveCwd, resolve(repository.path));
  assert.equal(report.scope, carrier.effectiveCwd);
  assert.deepEqual(report.contracts.find((contract) => contract.contractId === first), {
    contractId: first,
    phase: "bound",
    workspace: "here",
    worktreePath: null,
    target: null,
    verification: null,
  });
  assert.deepEqual(report.contracts.find((contract) => contract.contractId === second), {
    contractId: second,
    phase: "bound",
    workspace: "worktree",
    worktreePath: deliveryWorktreePath(carrier, second),
    target: null,
    verification: null,
  });
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 1);

  writeFileSync(log, "");
  const targeted = withGitShim(
    "printf '%s\\n' \"$*\" >> \"$KEIYAKU_STATUS_READ_LOG\"\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_STATUS_READ_LOG: log },
    () => statusOperation({ scope, contractId: first }),
  );
  assert.deepEqual(targeted.contracts.map((contract) => contract.contractId), [first]);
  const targetedInvocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(targetedInvocations.some((command) => command.includes("ls-tree -r")), false);
  assert.equal(targetedInvocations.some((command) => command.includes(contractJournalPath(first))), true);
});

test("batch reconcile isolates a failed contract and retains successful reports", () => {
  const repository = repositoryWithMain();
  const blocked = bind(repository, "Blocked reconcile", "worktree");
  const healthy = bind(repository, "Healthy reconcile", "worktree");
  const carrier = repositoryAt(repository.path);
  mkdirSync(deliveryWorktreePath(carrier, blocked), { recursive: true });

  const report = reconcileAllOperation({ scope: scopeOperation({ coordinate: repository.path }) });
  assert.equal(report.contracts.length, 2);

  const failed = report.contracts.find((contract) => contract.contractId === blocked);
  assert.deepEqual(failed?.kind, "failed");
  if (failed?.kind === "failed") assert.match(failed.diagnostic, /delivery worktree path is occupied/);

  const reconciled = report.contracts.find((contract) => contract.contractId === healthy);
  assert.equal(reconciled?.kind, "reconciled");
  assert.equal(existsSync(deliveryWorktreePath(carrier, healthy)), true);
});
