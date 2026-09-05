import assert from "node:assert/strict";
import test from "node:test";
import { auditResultSchema, deliveryResultSchema, reviewResultSchema } from "../src/library/mutation.js";
import {
  decodeContractLiveFailure,
  encodeContractLiveFailure,
  KeiyakuRefused,
  KeiyakuRetry,
} from "../src/library/refusal.js";
import { changeId, contractHead, contractId, entryUlid, snapshotId } from "../src/core/facts/types.js";
import { decodeSettlementLag } from "../src/settlement/settle.js";

const contract = contractId("kei/forwarding-codec");
const head = contractHead("head");
const tender = snapshotId("tender");
const predecessor = snapshotId("predecessor");
const snapshot = snapshotId("snapshot");
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
    cleanup: [],
    executionStops: [],
    facts: [fact],
    head,
    value: {
      tenderSnapshot: tender,
      integration: { predecessor, snapshot, changeId: patch },
      method: "squash",
      policy: { requireBranchesToBeUpToDate: false },
      ...value,
    },
    lags: [],
    settlementLags: [],
    pending: [],
    ...extras,
  };
}

test("accepted delivery round-trips owner settlement, verification, placement, cleanup, and continuation fields", () => {
  const result = acceptedDelivery(
    {
      completion: { integration: snapshot, verification: { mode: "ran", verdict: "satisfied" } },
      verification: { failure: "cancelled" },
      verificationReuse: { entry: fact.entry, verdict: "unsatisfied", summary: "reuse" },
      verificationSummary: "ran",
      placement: { failure: "target-placement-failed", diagnostic: "blocked" },
      continuation: {
        claimed: [contract],
        stopped: [{ contractId: contract, stop: { kind: "already-terminal" } }],
      },
    },
    {
      lags: [{ kind: "worktree-retained", path: "/tmp/worktree" }],
      settlementLags: [
        decodeSettlementLag({
          kind: "settlement-failed",
          surface: "task",
          contractId: contract,
          taskId: "task/forwarding",
          diagnostic: "task settlement refused",
        }),
      ],
      cleanup: [
        {
          kind: "verification-cleanup",
          contractId: contract,
          snapshot,
          failure: { phase: "destroy", command: 0, detail: { kind: "timeout" } },
        },
        { kind: "worktree-leak", contractId: contract, snapshot, leak: { path: "/tmp/leak", diagnostic: "retained" } },
      ],
      executionStops: [
        {
          kind: "execution-stopped",
          contractId: contract,
          stage: "continuation",
          reason: "failed",
          diagnostic: "discovery failed",
        },
      ],
      recoverySnapshot: snapshot,
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

test("malformed settlement lag and extra envelope fields are transport-integrity refusals", () => {
  assert.equal(deliveryResultSchema.safeParse(acceptedDelivery({}, { settlementLags: [{}] })).success, false);
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({}, { settlementLags: [{ kind: "settlement-failed", surface: "task", diagnostic: "lag" }] }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery(
        {},
        {
          settlementLags: [
            {
              kind: "settlement-failed",
              surface: "task",
              contractId: contract,
              taskId: "task/Forwarding",
              diagnostic: "lag",
            },
          ],
        },
      ),
    ).success,
    false,
  );
  assert.equal(deliveryResultSchema.safeParse({ ...acceptedDelivery(), extra: true }).success, false);
  assert.equal(deliveryResultSchema.safeParse(acceptedDelivery({ extra: true })).success, false);
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({}, { pending: [{ surface: "cleanup", required: false, extra: true }] }),
    ).success,
    false,
  );
});

test("refusal, retry, review, audit, and materialized conflict variants round-trip", () => {
  const refused = new KeiyakuRefused({ kind: "contract-missing", contractId: contract });
  const retry = new KeiyakuRetry({ kind: "publication-failed", diagnostic: "busy" });
  const retryEmpty = new KeiyakuRetry({ kind: "publication-failed", diagnostic: "" });
  assert.deepEqual(decodeContractLiveFailure(encodeContractLiveFailure(refused)), refused);
  assert.deepEqual(decodeContractLiveFailure(encodeContractLiveFailure(retry)), retry);
  assert.deepEqual(decodeContractLiveFailure(encodeContractLiveFailure(retryEmpty)), retryEmpty);
  assert.equal(decodeContractLiveFailure({ kind: "refused", refusal: { kind: "contract-missing" } }), null);

  const review = {
    kind: "accepted",
    operation: "review",
    cleanup: [],
    executionStops: [],
    facts: [],
    head,
    value: {
      workspace: {
        staged: [],
        unstaged: ["a"],
        untracked: [],
        shortStat: { filesChanged: 1, insertions: 1, deletions: 0 },
      },
      verification: { retry: { kind: "exhausted" } },
      continuation: {
        claimed: [contract],
        stopped: [{ contractId: contract, stop: { kind: "already-terminal" } }],
      },
    },
    lags: [],
    settlementLags: [],
    pending: [],
  };
  assert.deepEqual(reviewResultSchema.parse(JSON.parse(JSON.stringify(review))), review);

  const audit = {
    kind: "accepted",
    operation: "audit",
    cleanup: [],
    executionStops: [],
    facts: [],
    head,
    value: {
      candidate: { kind: "blocked", refusal: { kind: "target-missing", contractId: contract } },
      verification: { kind: "stopped", stop: { failure: "cancelled" } },
      target: { kind: "not-observed" },
    },
    lags: [],
    settlementLags: [],
    pending: [],
  };
  assert.deepEqual(auditResultSchema.parse(JSON.parse(JSON.stringify(audit))), audit);

  const conflict = {
    kind: "integration-conflict-materialized",
    targetHead: snapshot,
    conflictPaths: ["src/a.ts"],
    workspace: { kind: "worktree", path: "/tmp/worktree" },
  };
  assert.deepEqual(deliveryResultSchema.parse(JSON.parse(JSON.stringify(conflict))), conflict);
});

test("accepted mutation refuses a missing head", () => {
  const { head: _head, ...withoutHead } = acceptedDelivery();
  void _head;
  assert.equal(deliveryResultSchema.safeParse(withoutHead).success, false);
});

test("union branches refuse keys that belong to a different arm", () => {
  assert.equal(
    decodeContractLiveFailure({
      kind: "refused",
      refusal: { kind: "fork-source-missing", contractId: contract, extra: true },
    }),
    null,
  );
  assert.equal(
    decodeContractLiveFailure({
      kind: "refused",
      refusal: { kind: "nuke-confirmation-required", world: "world", extra: true },
    }),
    null,
  );
  assert.equal(
    auditResultSchema.safeParse({
      kind: "accepted",
      operation: "deliver",
      cleanup: [],
      executionStops: [],
      facts: [],
      head,
      value: {
        candidate: { kind: "blocked", refusal: { kind: "target-missing", contractId: contract } },
        verification: { kind: "not-run", extra: true },
        target: { kind: "not-observed" },
      },
      lags: [],
      settlementLags: [],
      pending: [],
    }).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({
        placement: { failure: "target-placement-failed", diagnostic: "blocked", extra: true },
      }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({
        placement: {
          refusal: {
            kind: "gates-unsatisfied",
            contractId: contract,
            unmet: [{ gate: "reviewed", current: { kind: "missing" } }],
            extra: true,
          },
        },
      }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({
        placement: {
          refusal: {
            kind: "prerequisites-unsatisfied",
            contractId: contract,
            unmet: [{ contractId: contract, state: "missing" }],
            extra: true,
          },
        },
      }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({
        placement: {
          refusal: {
            kind: "prerequisites-unsatisfied",
            contractId: contract,
            unmet: [{ contractId: contract, state: "missing", extra: true }],
          },
        },
      }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({
        placement: {
          refusal: {
            kind: "gates-unsatisfied",
            contractId: contract,
            unmet: [{ gate: "reviewed", current: { kind: "attested", verdict: "unsatisfied", at: "t", extra: true } }],
          },
        },
      }),
    ).success,
    false,
  );
});

function acceptedAudit(target: Record<string, unknown>) {
  return {
    kind: "accepted",
    operation: "audit",
    cleanup: [],
    executionStops: [],
    facts: [],
    head,
    value: {
      candidate: { kind: "blocked", refusal: { kind: "target-missing", contractId: contract } },
      verification: { kind: "not-run" },
      target,
    },
    lags: [],
    settlementLags: [],
    pending: [],
  };
}

test("audit target and git lag arms refuse keys that belong to a different arm", () => {
  assert.equal(auditResultSchema.safeParse(acceptedAudit({ kind: "not-observed", diagnostic: "no" })).success, false);
  assert.equal(
    auditResultSchema.safeParse(
      acceptedAudit({ kind: "placeable", ref: "refs/heads/main", head: snapshot, diagnostic: "no" }),
    ).success,
    false,
  );
  assert.equal(
    auditResultSchema.safeParse(
      acceptedAudit({
        kind: "moved",
        ref: "refs/heads/main",
        expected: snapshot,
        observed: null,
        diagnostic: "no",
      }),
    ).success,
    false,
  );
  assert.equal(
    auditResultSchema.safeParse(acceptedAudit({ kind: "failed", diagnostic: "boom", ref: "refs/heads/main" })).success,
    false,
  );
  assert.equal(
    auditResultSchema.safeParse(
      acceptedAudit({
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
      }),
    ).success,
    false,
  );
  assert.equal(
    deliveryResultSchema.safeParse(
      acceptedDelivery({}, { lags: [{ kind: "worktree-retained", path: "/tmp/worktree", diagnostic: "no" }] }),
    ).success,
    false,
  );
});

import { withExecutionReceipt, executionReceipt } from "../src/library/execution-result.js";
import { AuthorityCorruptionError } from "../src/core/facts/errors.js";

test("post-admission failures round-trip their category and receipt without becoming no-effect refusals", () => {
  for (const original of [new Error("unexpected"), new TypeError("bug"), new AuthorityCorruptionError("corrupt")]) {
    const receipt = {
      operation: "deliver" as const,
      contractId: contract,
      head,
      facts: [fact],
      cleanup: [],
      executionStops: [],
    };
    const encoded = encodeContractLiveFailure(withExecutionReceipt(original, receipt));
    assert.equal((encoded as { kind: string }).kind, "post-admission-failure");
    const decoded = decodeContractLiveFailure(encoded);
    assert.ok(decoded instanceof original.constructor);
    assert.equal(decoded instanceof KeiyakuRefused, false);
    assert.deepEqual(executionReceipt(decoded), receipt);
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
