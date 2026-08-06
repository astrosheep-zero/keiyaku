import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { deliveryWorktreePath } from "../src/carrier/reconcile.js";
import { repositoryAt } from "../src/carrier/repository.js";
import {
  bindOperation,
  reconcileAllOperation,
  scopeOperation,
  statusOperation,
} from "../src/protocol/operations.js";
import type { ContractBody, ContractId } from "../src/core/facts/types.js";
import { makeGitRepository, type TestGitRepository, withGitShim } from "./support/git.js";

function repositoryWithMain(): TestGitRepository {
  const repository = makeGitRepository();
  repository.run(["config", "user.name", "Test User"]);
  repository.run(["config", "user.email", "test@example.com"]);
  repository.run(["symbolic-ref", "HEAD", "refs/heads/main"]);
  repository.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  return repository;
}

function body(title: string): ContractBody {
  return {
    title,
    context: "Exercise the repository-level protocol reads.",
    objective: "Expose one pinned scope and snapshot-backed status.",
    design: "The protocol owns carrier observation and effects.",
    region: ["src/**"],
    criteria: [{ title: "Protocol result", body: "The operation returns only plain data." }],
    verification: [],
    extensions: [],
  };
}

function bind(repository: TestGitRepository, title: string, workspace: "worktree" | "here"): ContractId {
  const result = bindOperation({ coordinate: repository.path, body: body(title), workspace });
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
  const log = resolve(repository.path, "status-blob-reads.log");
  writeFileSync(log, "");

  const report = withGitShim(
    "if [ \"$1\" = \"cat-file\" ] && [ \"$2\" = \"blob\" ]; then printf '%s\\n' \"$3\" >> \"$KEIYAKU_STATUS_READ_LOG\"; fi\nexec \"$KEIYAKU_REAL_GIT\" \"$@\"",
    { KEIYAKU_STATUS_READ_LOG: log },
    () => statusOperation({ coordinate: repository.path }),
  );
  const carrier = repositoryAt(repository.path);

  assert.equal(report.contracts.length, 2);
  assert.deepEqual(scopeOperation({ coordinate: repository.path }), {
    coordinate: resolve(repository.path),
    root: carrier.primaryWorktree,
  });
  assert.equal(carrier.effectiveCwd, resolve(repository.path));
  assert.equal(report.scope, carrier.effectiveCwd);
  assert.deepEqual(report.contracts.find((contract) => contract.contractId === first), {
    contractId: first,
    phase: "bound",
    terminal: null,
    workspace: "here",
    worktreePath: null,
    target: null,
  });
  assert.deepEqual(report.contracts.find((contract) => contract.contractId === second), {
    contractId: second,
    phase: "bound",
    terminal: null,
    workspace: "worktree",
    worktreePath: deliveryWorktreePath(carrier, second),
    target: null,
  });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
});

test("batch reconcile isolates a failed contract and retains successful reports", () => {
  const repository = repositoryWithMain();
  const blocked = bind(repository, "Blocked reconcile", "worktree");
  const healthy = bind(repository, "Healthy reconcile", "worktree");
  const carrier = repositoryAt(repository.path);
  mkdirSync(deliveryWorktreePath(carrier, blocked), { recursive: true });

  const report = reconcileAllOperation({ coordinate: repository.path });
  assert.equal(report.contracts.length, 2);

  const failed = report.contracts.find((contract) => contract.contractId === blocked);
  assert.deepEqual(failed?.kind, "failed");
  if (failed?.kind === "failed") assert.match(failed.error, /delivery worktree path is occupied/);

  const reconciled = report.contracts.find((contract) => contract.contractId === healthy);
  assert.equal(reconciled?.kind, "reconciled");
  assert.equal(existsSync(deliveryWorktreePath(carrier, healthy)), true);
});
