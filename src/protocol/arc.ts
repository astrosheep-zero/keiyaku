import { decideArc } from "../core/verbs/arc.js";
import { admitSimpleIntent, type MutationOperationInput } from "./operations.js";

export async function arcOperation(
  input: MutationOperationInput & Readonly<{ chapter: Readonly<{ title: string; body: string }> }>,
) {
  return admitSimpleIntent(input, { data: input.chapter }, decideArc);
}
