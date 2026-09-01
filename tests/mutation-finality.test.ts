import assert from "node:assert/strict";
import test from "node:test";
import {
  Delivery,
  Keiyaku,
  KeiyakuRefused,
  KeiyakuRetry,
  Repo,
  projectMutationFinality,
  type AuditReport,
  type ChangeId,
  type ContractHead,
  type IntegrationConflictMaterialized,
  type MutationResult,
  type Review,
  type SnapshotId,
} from "../src/index.js";
import { contractId } from "../src/core/facts/types.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

function accepted<Value>(value: Value, extras: Partial<MutationResult<Value>> = {}): MutationResult<Value> {
  return {
    facts: [],
    head: "head" as ContractHead,
    value,
    lags: [],
    settlementLags: [],
    ...extras,
  };
}

function auditReport(): AuditReport {
  return {
    candidate: {
      kind: "blocked",
      refusal: { kind: "target-missing", contractId: contractId("kei/mutation-finality-test") },
    },
    verification: { kind: "satisfied", passed: 1, total: 1 },
    target: { kind: "not-observed" },
  };
}

function deliveryValue(): Delivery {
  const delivery = Object.create(Delivery.prototype) as Delivery & Record<string, unknown>;
  Object.assign(delivery, {
    tenderSnapshot: "snapshot" as SnapshotId,
    integration: {
      predecessor: "predecessor" as SnapshotId,
      snapshot: "snapshot" as SnapshotId,
      changeId: "change" as ChangeId,
    },
    method: "squash",
    policy: { requireBranchesToBeUpToDate: false },
  });
  return delivery;
}

test("audit terminal verification projects complete", () => {
  assert.deepEqual(projectMutationFinality(accepted(auditReport())), { kind: "complete" });
});

test("accepted audit cleanup and leak residue are optional pending work", () => {
  const residues: readonly Partial<Pick<MutationResult<AuditReport>, "cleanup" | "leak">>[] = [
    { cleanup: { phase: "destroy", command: 0, detail: { kind: "timeout" } } },
    { leak: { path: "/tmp/leak", diagnostic: "retained" } },
  ];
  for (const residue of residues) {
    assert.deepEqual(projectMutationFinality(accepted(auditReport(), residue)), {
      kind: "accepted-pending",
      pending: [{ surface: "cleanup", required: false }],
    });
  }
});

test("review placement is required pending work without a verb envelope", () => {
  const result: MutationResult<Review> = accepted({
    placement: { failure: "target-placement-failed", diagnostic: "blocked" },
  });
  assert.deepEqual(projectMutationFinality(result), {
    kind: "accepted-pending",
    pending: [{ surface: "placement", required: true }],
  });
});

test("accepted delivery cleanup and leak residue are optional pending work", () => {
  const residues: readonly Partial<Pick<MutationResult<Delivery>, "cleanup" | "leak">>[] = [
    { cleanup: { phase: "destroy", command: 0, detail: { kind: "timeout" } } },
    { leak: { path: "/tmp/leak", diagnostic: "retained" } },
  ];
  for (const residue of residues) {
    assert.deepEqual(projectMutationFinality(accepted(deliveryValue(), residue)), {
      kind: "accepted-pending",
      pending: [{ surface: "cleanup", required: false }],
    });
  }
});

test("public contract handle delivery result is projector input", async () => {
  const repository = repositoryWithMain();
  const bound = await Keiyaku.bind({
    repo: await Repo.at({ path: repository.path }),
    markdown: document(),
    workspace: "worktree",
    gates: [],
  });
  const result = await bound.keiyaku.deliver();
  assert.deepEqual(projectMutationFinality(result), { kind: "complete" });
});

test("materialized integration conflicts project not-admitted", () => {
  const result: IntegrationConflictMaterialized = {
    kind: "integration-conflict-materialized",
    targetHead: "target" as SnapshotId,
    conflictPaths: ["src/index.ts"],
    workspace: { kind: "worktree", path: "/tmp/worktree" },
  };
  assert.deepEqual(projectMutationFinality(result), { kind: "not-admitted" });
});

test("public refusal and retry results project not-admitted", () => {
  const refused = new KeiyakuRefused({
    kind: "target-missing",
    contractId: contractId("kei/mutation-finality-test"),
  });
  const retry = new KeiyakuRetry({ kind: "exhausted" });
  assert.deepEqual(projectMutationFinality(refused), { kind: "not-admitted" });
  assert.deepEqual(projectMutationFinality(retry), { kind: "not-admitted" });
});
