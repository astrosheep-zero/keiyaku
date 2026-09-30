import assert from "node:assert/strict";
import test from "node:test";
import {
  outcomeSchema,
  auditReportSchema,
  reviewSchema,
  KeiyakuError,
  encodeFailureWire,
  decodeFailureWire,
  withOutcomeReceipt,
} from "../src/library/outcome.js";
import { deliveryValueSchema } from "../src/library/delivery.js";
import { ownerSchema } from "../src/library/result-codec.js";
import { decodeMaterializedConflict } from "../src/protocol/result-codec.js";
const deliveryResultSchema = outcomeSchema(
  "deliver",
  deliveryValueSchema,
  ownerSchema(decodeMaterializedConflict, "expected handoff"),
);
const reviewResultSchema = outcomeSchema("review", reviewSchema);
const auditResultSchema = outcomeSchema("audit", auditReportSchema);
import { changeId, contractHead, contractId, entryUlid, snapshotId } from "../src/core/facts/types.js";
import { decodeDeliverConflictRefusal, decodeVerificationRuntimeStop } from "../src/protocol/result-codec.js";
import { decodeSettlementLag } from "../src/settlement/settle.js";

const contract = contractId("kei/forwarding-codec");
const head = contractHead("head");
const tender = snapshotId("tender");
const predecessor = snapshotId("predecessor");
const snapshot = snapshotId("snapshot");
const gitTender = snapshotId("0123456789abcdef0123456789abcdef01234567");
const gitHead = snapshotId("fedcba9876543210fedcba9876543210fedcba98");
const patch = changeId("change");
const fact = {
  v: 1 as const,
  kind: "deliver" as const,
  contract,
  entry: entryUlid("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  at: "2026-08-06T00:00:00.000Z",
  data: {
    tenderSnapshot: tender,
    integration: { predecessor, snapshot, changeId: patch },
    method: "squash" as const,
    policy: { requireBranchesToBeUpToDate: false },
  },
};

function acceptedDelivery(value: Record<string, unknown> = {}, extras: Record<string, unknown> = {}) {
  return {
    kind: "accepted",
    operation: "deliver",
    contract,
    effects: [],
    facts: [fact],
    head,
    value: {
      tenderSnapshot: tender,
      integration: { predecessor, snapshot, changeId: patch },
      method: "squash",
      policy: { requireBranchesToBeUpToDate: false },
      leading: { kind: "admitted-now", fact: fact.entry },
      ...value,
    },
    pending: [],
    ...extras,
  };
}

function refusesDelivery(value: Record<string, unknown> = {}, extras: Record<string, unknown> = {}): void {
  assert.equal(deliveryResultSchema.safeParse(acceptedDelivery(value, extras)).success, false);
}

test("accepted delivery round-trips owner settlement, verification, placement, cleanup, and continuation fields", () => {
  const result = acceptedDelivery(
    {
      completion: {
        integration: snapshot,
        target: "refs/heads/main",
        predecessor,
        verification: { mode: "ran", verdict: "satisfied" },
      },
      verification: {
        failure: "cancelled",
        stdout: "forwarded delivery tail",
        stderr: "delivery diagnostic",
        truncated: true,
      },
      verificationReuse: { entry: fact.entry, verdict: "unsatisfied", summary: "reuse" },
      verificationSummary: "ran",
      continuation: {
        claimed: [contract],
        stopped: [{ contractId: contract, stop: { kind: "already-terminal" } }],
      },
    },
    {
      effects: [
        {
          kind: "reconciliation-lag",
          contract,
          affects: "none",
          lag: { kind: "worktree-retained", path: "/tmp/worktree" },
        },
        {
          kind: "settlement-lag",
          contract,
          lag: decodeSettlementLag({
            kind: "settlement-failed",
            surface: "task",
            contractId: contract,
            taskId: "task/forwarding",
            diagnostic: "task settlement refused",
          }),
        },
        {
          kind: "cleanup",
          contract,
          issue: {
            kind: "verification-cleanup",
            contractId: contract,
            snapshot,
            failure: { phase: "destroy", name: "destroy", detail: { kind: "timeout" } },
          },
        },
        {
          kind: "cleanup",
          contract,
          issue: {
            kind: "worktree-leak",
            contractId: contract,
            snapshot,
            leak: { path: "/tmp/leak", diagnostic: "retained" },
          },
        },
        {
          kind: "execution-stopped",
          contract,
          stage: "continuation",
          reason: "failed",
          diagnostic: "discovery failed",
        },
      ],
      pending: [
        { surface: "verification", required: true },
        { surface: "placement", required: true },
        { surface: "continuation", required: true },
        { surface: "reconciliation", required: true },
        { surface: "settlement", required: true },
        { surface: "cleanup", required: false },
      ],
    },
  );
  const parsed = deliveryResultSchema.parse(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(parsed, result);
});

test("forwarded reconciliation lags preserve their repair scope", () => {
  const result = acceptedDelivery(
    {},
    {
      effects: [
        {
          kind: "reconciliation-lag",
          contract,
          affects: "continuation",
          lag: {
            kind: "worktree-follow-retained",
            path: "/tmp/dependent",
            tender: gitTender,
            head: gitHead,
            reason: "head-moved",
          },
        },
        {
          kind: "reconciliation-lag",
          contract,
          affects: "placement",
          lag: { kind: "target-checkout-retained", path: "/tmp/main", target: "refs/heads/main", diagnostic: "dirty" },
        },
        {
          kind: "reconciliation-lag",
          contract,
          affects: "reconciliation",
          lag: { kind: "reconcile-failed", stage: "effect", diagnostic: "busy" },
        },
      ],
    },
  );
  assert.deepEqual(deliveryResultSchema.parse(JSON.parse(JSON.stringify(result))), result);
});

test("delivery leading preserves both witnessed arms and refuses a missing provenance", () => {
  const fresh = acceptedDelivery();
  assert.deepEqual(deliveryResultSchema.parse(JSON.parse(JSON.stringify(fresh))), fresh);
  const continued = acceptedDelivery({ leading: { kind: "already-admitted", fact: fact.entry } }, { facts: [] });
  assert.deepEqual(deliveryResultSchema.parse(JSON.parse(JSON.stringify(continued))), continued);
  const { leading: _dropped, ...withoutLeading } = fresh.value;
  void _dropped;
  assert.equal(deliveryResultSchema.safeParse({ ...fresh, value: withoutLeading }).success, false);
  assert.equal(
    deliveryResultSchema.safeParse(acceptedDelivery({ leading: { kind: "fresh", fact: fact.entry } })).success,
    false,
  );
});

test("malformed settlement lag and extra envelope fields are transport-integrity refusals", () => {
  refusesDelivery({}, { effects: [{ kind: "settlement-lag", contract, lag: {} }] });
  refusesDelivery(
    {},
    {
      effects: [
        { kind: "settlement-lag", contract, lag: { kind: "settlement-failed", surface: "task", diagnostic: "lag" } },
      ],
    },
  );
  refusesDelivery(
    {},
    {
      effects: [
        {
          kind: "settlement-lag",
          contract,
          lag: {
            kind: "settlement-failed",
            surface: "task",
            contractId: contract,
            taskId: "task/Forwarding",
            diagnostic: "lag",
          },
        },
      ],
    },
  );
  assert.equal(deliveryResultSchema.safeParse({ ...acceptedDelivery(), extra: true }).success, false);
  refusesDelivery({ extra: true });
  refusesDelivery(
    {},
    {
      effects: [
        {
          kind: "reconciliation-lag",
          contract,
          affects: "none",
          lag: {
            kind: "target-checkout-retained",
            path: "/tmp/main",
            target: "refs/heads/main",
            diagnostic: "dirty",
          },
        },
      ],
    },
  );
  refusesDelivery({}, { pending: [{ surface: "cleanup", required: false, extra: true }] });
});

test("refusal, retry, review, audit, and materialized conflict variants round-trip", () => {
  const refused = {
    operation: "deliver",
    kind: "refused",
    contract,
    facts: [],
    effects: [],
    pending: [],
    refusal: { kind: "contract-missing", contractId: contract },
  };
  const retry = {
    operation: "deliver",
    kind: "retry",
    contract,
    facts: [],
    effects: [],
    pending: [],
    reason: { kind: "publication-failed", diagnostic: "busy" },
  };
  const retryEmpty = { ...retry, reason: { kind: "publication-failed", diagnostic: "" } };
  for (const result of [refused, retry, retryEmpty])
    assert.deepEqual(deliveryResultSchema.parse(JSON.parse(JSON.stringify(result))), result);
  assert.equal(deliveryResultSchema.safeParse({ ...refused, refusal: { kind: "contract-missing" } }).success, false);

  const review = {
    kind: "accepted",
    operation: "review",
    contract,
    effects: [],
    facts: [],
    head,
    value: {
      workspace: {
        staged: [],
        unstaged: ["a"],
        untracked: [],
        shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
        unmergedPaths: [],
      },
      verification: { failure: "unknown-exit", stdout: "forwarded review tail" },
      continuation: {
        claimed: [contract],
        stopped: [{ contractId: contract, stop: { kind: "already-terminal" } }],
      },
    },
    pending: [],
  };
  assert.deepEqual(reviewResultSchema.parse(JSON.parse(JSON.stringify(review))), review);

  const audit = {
    kind: "accepted",
    operation: "audit",
    contract,
    effects: [],
    facts: [],
    head,
    value: {
      candidate: { kind: "blocked", refusal: { kind: "target-missing", contractId: contract } },
      verification: {
        kind: "stopped",
        stop: { failure: "spawn-error", diagnostic: "spawn refused", stderr: "forwarded audit tail", truncated: true },
      },
      target: { kind: "not-observed" },
    },
    pending: [],
  };
  assert.deepEqual(auditResultSchema.parse(JSON.parse(JSON.stringify(audit))), audit);

  const conflict = {
    operation: "deliver",
    kind: "handoff",
    contract,
    facts: [],
    effects: [],
    pending: [],
    value: {
      kind: "integration-conflict-materialized",
      targetHead: snapshot,
      handoffBase: snapshot,
      recovery: {
        materialize: "deliver --materialize-conflict --include-dirty",
        deliver: "deliver --include-dirty",
        staging: "not-required",
      },
      conflictPaths: ["src/a.ts"],
      workspace: { kind: "worktree", path: "/tmp/worktree" },
    },
  };
  assert.deepEqual(
    deliveryResultSchema.parse(JSON.parse(JSON.stringify({ ...conflict, value: conflict.value }))),
    conflict,
  );
});

test("conflict recovery codecs reject the legacy continue field", () => {
  const recovery = {
    materialize: "deliver --materialize-conflict --include-dirty",
    deliver: "deliver --include-dirty",
    staging: "not-required",
  };
  const materialized = {
    operation: "deliver",
    kind: "handoff",
    contract,
    facts: [],
    effects: [],
    pending: [],
    value: {
      kind: "integration-conflict-materialized",
      targetHead: snapshot,
      handoffBase: snapshot,
      recovery,
      conflictPaths: ["src/a.ts"],
      workspace: { kind: "worktree", path: "/tmp/worktree" },
    },
  };
  assert.deepEqual(deliveryResultSchema.parse(JSON.parse(JSON.stringify(materialized))), materialized);
  const legacyRecovery = { materialize: recovery.materialize, continue: recovery.deliver, staging: recovery.staging };
  assert.equal(
    deliveryResultSchema.safeParse({ ...materialized, value: { ...materialized.value, recovery: legacyRecovery } })
      .success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse({
      ...materialized,
      value: { ...materialized.value, recovery: { ...recovery, continue: recovery.deliver } },
    }).success,
    false,
  );

  const refusal = {
    kind: "integration-failed",
    contractId: contract,
    reason: "conflict",
    targetHead: snapshot,
    conflictPaths: ["src/a.ts"],
    recovery,
  };
  assert.deepEqual(decodeDeliverConflictRefusal(JSON.parse(JSON.stringify(refusal))), refusal);
  assert.throws(() => decodeDeliverConflictRefusal({ ...refusal, recovery: legacyRecovery }));
  assert.throws(() =>
    decodeDeliverConflictRefusal({ ...refusal, recovery: { ...recovery, continue: recovery.deliver } }),
  );
});

test("Verification runtime stops preserve only canonical captured output fields", () => {
  assert.deepEqual(decodeVerificationRuntimeStop({ failure: "cancelled", stdout: "tail", truncated: true }), {
    failure: "cancelled",
    stdout: "tail",
    truncated: true,
  });
  assert.deepEqual(decodeVerificationRuntimeStop({ failure: "unknown-exit", stderr: " " }), {
    failure: "unknown-exit",
    stderr: " ",
  });
  assert.deepEqual(
    decodeVerificationRuntimeStop({
      failure: "environment-failure",
      name: "setup",
      detail: { kind: "timeout" },
      stderr: "hook tail",
    }),
    {
      failure: "environment-failure",
      name: "setup",
      detail: { kind: "timeout" },
      stderr: "hook tail",
    },
  );
  assert.throws(
    () => decodeVerificationRuntimeStop({ failure: "cancelled", stdout: "" }),
    /malformed protocol result/u,
  );
  assert.throws(
    () => decodeVerificationRuntimeStop({ failure: "cancelled", truncated: false }),
    /malformed protocol result/u,
  );
  assert.throws(
    () => decodeVerificationRuntimeStop({ failure: "cancelled", diagnostic: "not this variant" }),
    /malformed protocol result/u,
  );
});

test("accepted mutation refuses a missing head", () => {
  const { head: _head, ...withoutHead } = acceptedDelivery();
  void _head;
  assert.equal(deliveryResultSchema.safeParse(withoutHead).success, false);
});

test("union branches refuse keys that belong to a different arm", () => {
  assert.equal(
    outcomeSchema("bind", reviewSchema).safeParse({
      operation: "bind",
      kind: "refused",
      contract,
      facts: [],
      effects: [],
      pending: [],
      refusal: { kind: "fork-source-missing", contractId: contract, extra: true },
    }).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse({
      operation: "deliver",
      kind: "refused",
      facts: [],
      effects: [],
      pending: [],
      refusal: { kind: "nuke-confirmation-required", world: "world", extra: true },
    }).success,
    false,
  );
  assert.equal(
    auditResultSchema.safeParse({
      kind: "accepted",
      operation: "deliver",
      contract,
      effects: [],
      facts: [],
      head,
      value: {
        candidate: { kind: "blocked", refusal: { kind: "target-missing", contractId: contract } },
        verification: { kind: "not-run", extra: true },
        target: { kind: "not-observed" },
      },

      pending: [],
    }).success,
    false,
  );
  refusesDelivery({
    placement: { failure: "target-placement-failed", diagnostic: "blocked", extra: true },
  });
  refusesDelivery({
    placement: {
      refusal: {
        kind: "gates-unsatisfied",
        contractId: contract,
        unmet: [{ gate: "reviewed", current: { kind: "missing" } }],
        extra: true,
      },
    },
  });
  refusesDelivery({
    placement: {
      refusal: {
        kind: "prerequisites-unsatisfied",
        contractId: contract,
        unmet: [{ contractId: contract, state: "missing" }],
        extra: true,
      },
    },
  });
  refusesDelivery({
    placement: {
      refusal: {
        kind: "prerequisites-unsatisfied",
        contractId: contract,
        unmet: [{ contractId: contract, state: "missing", extra: true }],
      },
    },
  });
  refusesDelivery({
    placement: {
      refusal: {
        kind: "gates-unsatisfied",
        contractId: contract,
        unmet: [{ gate: "reviewed", current: { kind: "attested", verdict: "unsatisfied", at: "t", extra: true } }],
      },
    },
  });
});

function acceptedAudit(target: Record<string, unknown>) {
  return {
    kind: "accepted",
    operation: "audit",
    contract,
    effects: [],
    facts: [],
    head,
    value: {
      candidate: { kind: "blocked", refusal: { kind: "target-missing", contractId: contract } },
      verification: { kind: "not-run" },
      target,
    },
    pending: [],
  };
}

function refusesAudit(target: Record<string, unknown>): void {
  assert.equal(auditResultSchema.safeParse(acceptedAudit(target)).success, false);
}

test("audit target and git lag arms refuse keys that belong to a different arm", () => {
  refusesAudit({ kind: "not-observed", diagnostic: "no" });
  refusesAudit({ kind: "placeable", ref: "refs/heads/main", head: snapshot, diagnostic: "no" });
  refusesAudit({
    kind: "moved",
    ref: "refs/heads/main",
    expected: snapshot,
    observed: null,
    diagnostic: "no",
  });
  refusesAudit({ kind: "failed", diagnostic: "boom", ref: "refs/heads/main" });
  refusesAudit({
    kind: "refused",
    refusal: {
      kind: "checkout-not-followable",
      contractId: contract,
      target: "refs/heads/main",
      path: "/tmp/worktree",
      reason: "staged",
      paths: ["a"],
    },
    diagnostic: "no",
  });
  refusesDelivery(
    {},
    {
      effects: [
        {
          kind: "reconciliation-lag",
          contract,
          affects: "placement",
          lag: { kind: "worktree-retained", path: "/tmp/worktree", diagnostic: "no" },
        },
      ],
    },
  );
});

import { AuthorityCorruptionError } from "../src/core/facts/errors.js";

test("post-admission failures round-trip their category and receipt without becoming no-effect refusals", () => {
  for (const original of [new Error("unexpected"), new TypeError("bug"), new AuthorityCorruptionError("corrupt")]) {
    const receipt = { operation: "deliver" as const, contract, head, facts: [fact], effects: [], pending: [] };
    const encoded = encodeFailureWire(withOutcomeReceipt(original, receipt));
    assert.equal(encoded.kind, "failed");
    const decoded = decodeFailureWire(encoded);
    assert.ok(decoded instanceof KeiyakuError);
    assert.equal(decoded.category, original instanceof AuthorityCorruptionError ? "authority-corruption" : "internal");
    assert.ok(decoded.cause instanceof original.constructor);
    assert.deepEqual(decoded.outcome, receipt);
  }
});

test("result codecs reject obsolete cleanup fields, missing operation and cross-operation answers", () => {
  const result = acceptedDelivery();
  assert.equal(reviewResultSchema.safeParse(result).success, false);
  const { operation: _operation, ...untagged } = result;
  assert.equal(deliveryResultSchema.safeParse(untagged).success, false);
  assert.equal(deliveryResultSchema.safeParse({ ...result, cleanup: {} }).success, false);
  assert.equal(deliveryResultSchema.safeParse({ ...result, leak: { path: "/old", diagnostic: "old" } }).success, false);
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({ cleanup: { phase: "destroy", command: 0, detail: { kind: "timeout" } } }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse({
      ...result,
      cleanup: [
        { kind: "worktree-leak", contractId: contract, leak: { path: "/new", diagnostic: "retained" }, extra: true },
      ],
    }).success,
    false,
  );
});
