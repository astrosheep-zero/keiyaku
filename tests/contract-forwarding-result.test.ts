import assert from "node:assert/strict";
import test from "node:test";
import { deliveryResultSchema } from "../src/library/contract-forwarding-result.js";

test("forwarded gate testimony preserves its established key order", () => {
  const result = deliveryResultSchema.parse({
    facts: [],
    head: "head",
    value: {
      tenderSnapshot: "tender",
      integration: { predecessor: "predecessor", snapshot: "snapshot", changeId: "change" },
      method: "squash",
      policy: { requireBranchesToBeUpToDate: false },
      placement: {
        refusal: {
          kind: "gates-unsatisfied",
          contractId: "kei/gated",
          unmet: [
            {
              gate: "reviewed",
              current: { kind: "attested", verdict: "satisfied", summary: "ready", at: "2026-08-31" },
            },
          ],
        },
      },
    },
    lags: [],
    settlementLags: [],
  });
  const placement = result.value.placement;
  assert.ok(placement !== undefined && "refusal" in placement && placement.refusal.kind === "gates-unsatisfied");
  assert.deepEqual(Object.keys(placement.refusal.unmet[0]!.current), ["kind", "verdict", "at", "summary"]);
});
