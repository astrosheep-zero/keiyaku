import { decideArc } from "../core/verbs/arc.js";
import type { ActiveContractRefusal } from "../core/facts/observation.js";
import { admitIntent } from "./intent.js";
import { complete } from "./outcome.js";
import type { IntentOutcome, MutationOperationInput } from "./operations.js";
import { timestamp } from "./operations.js";

export async function arcOperation(
  input: MutationOperationInput & Readonly<{ chapter: Readonly<{ title: string; body: string }> }>,
): Promise<IntentOutcome<void, ActiveContractRefusal>> {
  return complete(
    await admitIntent(
      input.channel,
      input.scope,
      {
        contractId: input.contractId,
        ...(input.actor === undefined ? {} : { actor: input.actor }),
        at: timestamp(),
        data: input.chapter,
      },
      decideArc,
    ),
    undefined,
  );
}
