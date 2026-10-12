import { decideArc } from "../core/verbs/arc.js";
import type { ActiveContractRefusal } from "../core/facts/observation.js";
import { admitVoidIntent, type IntentOutcome, type MutationOperationInput } from "./operations.js";

export async function arcOperation(
  input: MutationOperationInput & Readonly<{ chapter: Readonly<{ title: string; body: string }> }>,
): Promise<IntentOutcome<void, ActiveContractRefusal>> {
  return admitVoidIntent(input, { data: input.chapter }, decideArc);
}
