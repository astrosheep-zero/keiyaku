import assert from "node:assert/strict";
import test from "node:test";
import { reconciliationLagSchema } from "../src/library/contract-forwarding-reconciliation-result.js";

test("forwarded reconciliation decodes ref migration conflicts", () => {
  const oid = "1".repeat(40);
  const value = {
    kind: "ref-migration-conflict",
    legacyRef: "refs/heads/keiyaku-delivery/kei-example",
    legacyOid: oid,
    currentRef: "refs/keiyaku/delivery/kei-example",
    currentOid: "2".repeat(40),
  };

  assert.deepEqual(reconciliationLagSchema.parse(value), value);
  assert.equal(reconciliationLagSchema.safeParse({ ...value, currentOid: "not-an-oid" }).success, false);
});
