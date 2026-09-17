import { contractHead } from "../../src/core/facts/types.js";

/** Fresh receipt carriers only; expected renderings stay independent at the call site. */
export function receipt<const T extends { verb: string }>(values: T) {
  return { kind: "accepted" as const, head: contractHead("head"), facts: [], settlementLags: [], ...values };
}
