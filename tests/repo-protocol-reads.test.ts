import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { deliveryWorktreePath } from "../src/carrier/reconcile.js";
import { repositoryAt } from "../src/carrier/repository.js";
import { decodeContractDocument } from "../src/body/decode.js";
import {
  bindOperation,
  contractObservationOperation,
  contractsOperation,
  reconcileAllOperation,
  scopeOperation,
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
    title,
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

test("Contract reads return plain pinned data from one carrier snapshot", () => {
  const repository = repositoryWithMain();
  const first = bind(repository, "First status row", "here");
  const second = bind(repository, "Second status row", "worktree");
  const scope = scopeOperation({ coordinate: repository.path });
  const log = resolve(repository.path, "status-blob-reads.log");
  writeFileSync(log, "");

  const report = withGitShim(
    "if [ \"$1\" = \"cat-file\" ]; then printf '%s\\n' \"$*\" >> \"$KEIYAKU_STATUS_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_STATUS_READ_LOG: log },
    () => contractsOperation({ scope }),
  );
  const carrier = repositoryAt(repository.path);

  assert.equal(report.rows.length, 2);
  assert.equal(scope.effectiveCwd, resolve(repository.path));
  assert.equal(scope.primaryWorktree, carrier.primaryWorktree);
  assert.equal(carrier.effectiveCwd, resolve(repository.path));
  assert.equal(report.root, carrier.primaryWorktree);
  assert.deepEqual(report.rows.find((contract) => contract.id === first), {
    id: first,
    phase: "bound",
    disposition: "active",
    workspace: "here",
    worktreePath: null,
    target: null,
    candidate: null,
    gates: { reports: [], satisfied: true },
  });
  assert.deepEqual(report.rows.find((contract) => contract.id === second), {
    id: second,
    phase: "bound",
    disposition: "active",
    workspace: "worktree",
    worktreePath: deliveryWorktreePath(carrier, second),
    target: null,
    candidate: null,
    gates: { reports: [], satisfied: true },
  });
  const invocations = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(invocations.filter((command) => command === "cat-file --batch").length, 1);
  assert.equal(invocations.filter((command) => command.startsWith("cat-file blob ")).length, 1);

  assert.deepEqual(contractObservationOperation({ scope, contractId: first }), {
    kind: "present",
    row: report.rows.find((contract) => contract.id === first),
  });
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
  assert.equal(failed?.report.lag[0]?.kind, "reconcile-failed");
  if (failed?.report.lag[0]?.kind === "reconcile-failed") {
    assert.equal(failed.report.lag[0].stage, "effect");
    assert.match(failed.report.lag[0].diagnostic, /delivery worktree path is occupied/);
  }

  const reconciled = report.contracts.find((contract) => contract.contractId === healthy);
  assert.deepEqual(reconciled?.report.lag, []);
  assert.equal(existsSync(deliveryWorktreePath(carrier, healthy)), true);
});
