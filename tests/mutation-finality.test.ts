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
  type IntegrationConflictMaterialized,
  type MutationFinalityInput,
  type MutationPendingSurface,
  type MutationResult,
  type Review,
  type SnapshotId,
} from "../src/index.js";
import { concatenatePrivateStateSeatClose } from "../src/git/private-state-seat.js";
import {
  contractId,
  documentKey,
  snapshotId,
  type ContractHead,
  type ContractState,
} from "../src/core/facts/types.js";
import {
  auditPending,
  collectAcceptedPending,
  completionPending,
  noValuePending,
} from "../src/library/mutation.js";
import { mergeAdmissions } from "../src/protocol/operations.js";
import { document, repositoryWithMain } from "./support/library-verbs.js";

function accepted<Value>(
  value: Value,
  extras: Partial<MutationResult<Value>> = {},
  valuePending: (value: Value) => readonly MutationPendingSurface[] = noValuePending,
): MutationResult<Value> {
  const result = {
    kind: "accepted" as const,
    facts: [],
    head: "head" as ContractHead,
    value,
    lags: [],
    settlementLags: [],
    pending: [] as MutationResult<Value>["pending"],
    ...extras,
  };
  if (extras.pending !== undefined) return result;
  return {
    ...result,
    pending: collectAcceptedPending(valuePending(value), {
      lags: result.lags,
      settlementLags: result.settlementLags,
      ...(result.cleanup === undefined ? {} : { cleanup: result.cleanup }),
      ...(result.leak === undefined ? {} : { leak: result.leak }),
      ...(result.seatClose === undefined || result.seatClose.length === 0 ? {} : { seatClose: result.seatClose }),
    }),
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
  assert.deepEqual(projectMutationFinality(accepted(auditReport(), {}, auditPending)), { kind: "complete" });
});

test("accepted audit cleanup and leak residue are optional pending work", () => {
  const residues: readonly Partial<Pick<MutationResult<AuditReport>, "cleanup" | "leak">>[] = [
    { cleanup: { phase: "destroy", command: 0, detail: { kind: "timeout" } } },
    { leak: { path: "/tmp/leak", diagnostic: "retained" } },
  ];
  for (const residue of residues) {
    assert.deepEqual(projectMutationFinality(accepted(auditReport(), residue, auditPending)), {
      kind: "accepted-pending",
      pending: [{ surface: "cleanup", required: false }],
    });
  }
});

test("review placement is required pending work without a verb envelope", () => {
  const result: MutationResult<Review> = accepted(
    {
      placement: { failure: "target-placement-failed", diagnostic: "blocked" },
    },
    {},
    completionPending,
  );
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
    assert.deepEqual(projectMutationFinality(accepted(deliveryValue(), residue, completionPending)), {
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

test("merged admissions concatenate every confirmed seat-close lag in order", () => {
  const first = {
    kind: "private-state-seat-close-failed" as const,
    diagnostic: "first seat close failed",
  };
  const second = {
    kind: "private-state-seat-close-failed" as const,
    diagnostic: "second seat close failed",
  };
  const state: ContractState = {
    id: contractId("kei/mutation-finality-test"),
    head: "head" as ContractHead,
    coordinates: { start: snapshotId("base"), workspace: "worktree" },
    terms: { document: { bytes: "# Test", key: documentKey("document") }, segments: [], gates: [], after: [] },
    bound: null,
    delivery: null,
    currentIntegration: null,
    attestations: [],
    terminal: null,
  };
  const current = {
    kind: "accepted" as const,
    facts: [],
    state,
    journal: [],
    seatClose: [first],
  };
  const next = {
    kind: "accepted" as const,
    facts: [],
    state,
    journal: [],
    seatClose: [second],
  };
  const merged = mergeAdmissions(current, next);
  assert.deepEqual(merged.seatClose, [first, second]);
  const seatClose = concatenatePrivateStateSeatClose(current.seatClose, next.seatClose);
  assert.deepEqual(seatClose, [first, second]);
  assert.deepEqual(projectMutationFinality(accepted(undefined, { seatClose: merged.seatClose })), {
    kind: "accepted-pending",
    pending: [{ surface: "cleanup", required: false }],
  });
});

test("mutation finality ignores transported pending without authoritative surfaces", () => {
  const authoritative = {
    kind: "accepted" as const,
    facts: [],
    head: "head" as ContractHead,
    value: undefined as void,
    lags: [],
    settlementLags: [],
    pending: [] as MutationResult<void>["pending"],
    seatClose: [{ kind: "private-state-seat-close-failed" as const, diagnostic: "seat close failed" }],
  };
  assert.deepEqual(projectMutationFinality(authoritative), {
    kind: "accepted-pending",
    pending: [{ surface: "cleanup", required: false }],
  });
  assert.deepEqual(
    projectMutationFinality({
      ...authoritative,
      pending: [{ surface: "placement", required: true }],
      seatClose: undefined,
    }),
    { kind: "complete" },
  );
  assert.deepEqual(projectMutationFinality(authoritative), projectMutationFinality({ ...authoritative }));
});

test("mutation nuke confirmed seat-close failure remains a typed outcome", async () => {
  const { rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { World } = await import("../src/world.js");
  const { nukeGit } = await import("../src/git/nuke.js");
  const { nukeKeiyaku } = await import("../src/library/nuke.js");
  const { makeGitRepository } = await import("./support/git.js");
  const raw = makeGitRepository();
  raw.run(["config", "user.name", "Test User"]);
  raw.run(["config", "user.email", "test@example.com"]);
  raw.run(["commit", "--allow-empty", "--quiet", "-m", "initial"]);
  raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
  writeFileSync(join(raw.path, ".git", "info", "exclude"), ".keiyaku/locks/\n");
  try {
    const world = await World.at(raw.path);
    const close = () => {
      throw new Error("nuke seat close failed after publication");
    };
    const outcome = await nukeGit(world, "git", { onPrivateStateSeatClose: close });
    assert.equal("value" in outcome, true);
    assert.deepEqual(outcome.closeLag, {
      kind: "private-state-seat-close-failed",
      diagnostic: "nuke seat close failed after publication",
    });

    raw.run(["update-ref", "refs/heads/keiyaku-state", "HEAD"]);
    const publicResult = await nukeKeiyaku({ world, confirm: world }, { onPrivateStateSeatClose: close });
    assert.equal(publicResult.kind, "success");
    assert.notDeepEqual(publicResult, { kind: "success", world });
    assert.deepEqual(publicResult.seatClose, [
      {
        kind: "private-state-seat-close-failed",
        diagnostic: "nuke seat close failed after publication",
      },
    ]);
  } finally {
    rmSync(raw.path, { recursive: true, force: true });
  }
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

test("structurally similar values without an accepted discriminant are not complete", () => {
  const lookalike = {
    facts: [],
    head: "head" as ContractHead,
    value: {
      candidate: { kind: "blocked" as const, refusal: { kind: "target-missing" as const, contractId: contractId("kei/mutation-finality-test") } },
      verification: { kind: "stopped" as const, stop: { retry: { kind: "exhausted" as const } } },
      target: { kind: "not-observed" as const },
      placement: { failure: "target-placement-failed" as const, diagnostic: "blocked" },
    },
    lags: [],
    settlementLags: [],
    pending: [{ surface: "placement" as const, required: true }],
  };
  assert.deepEqual(projectMutationFinality(lookalike as unknown as MutationFinalityInput), { kind: "not-admitted" });
});

test("cross-realm refusal lookalikes without typed kind remain not-admitted", () => {
  const lookalike = {
    name: "KeiyakuRefused",
    message: "Keiyaku refused: target-missing",
    refusal: { kind: "target-missing" as const, contractId: contractId("kei/mutation-finality-test") },
  };
  assert.equal(lookalike instanceof KeiyakuRefused, false);
  assert.deepEqual(projectMutationFinality(lookalike as unknown as MutationFinalityInput), { kind: "not-admitted" });
});

test("cross-realm accepted lookalikes without the owner discriminant remain not-admitted", () => {
  const lookalike = {
    name: "MutationResult",
    facts: [],
    head: "head" as ContractHead,
    value: undefined,
    lags: [],
    settlementLags: [],
    pending: [],
  };
  assert.deepEqual(projectMutationFinality(lookalike as unknown as MutationFinalityInput), { kind: "not-admitted" });
});
