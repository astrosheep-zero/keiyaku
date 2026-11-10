import { decideArc } from "../core/verbs/arc.js";
import type { ActiveContractRefusal } from "../core/facts/observation.js";
import { admitVoidIntent, type IntentOutcome, type MutationOperationInput } from "./operations.js";

export async function arcOperation(
  input: MutationOperationInput & Readonly<{ chapter: Readonly<{ title: string; body: string }> }>,
): Promise<IntentOutcome<Readonly<{ chapter: number; title: string }>, ActiveContractRefusal>> {
  const result = await admitVoidIntent(input, { data: input.chapter }, decideArc);
  if (result.kind !== "accepted") return result;
  const arc = result.facts.find((fact) => fact.kind === "arc" && fact.contract === input.contractId);
  if (arc?.kind !== "arc") throw new Error("arc receipt requires its admitted sequence");
  return { ...result, value: { chapter: arc.data.seq, title: input.chapter.title } };
}
