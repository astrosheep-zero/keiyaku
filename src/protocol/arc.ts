import type { ArcData } from "../core/facts/types.js";
import { decideArc, type ArcRefusal } from "../core/verbs/arc.js";
import { admitIntent } from "./intent.js";
import { complete } from "./outcome.js";
import type { IntentOutcome, MutationOperationInput } from "./operations.js";
import { timestamp } from "./operations.js";

export async function arcOperation(
  input: MutationOperationInput & Readonly<{ chapter: Omit<ArcData, "seq"> }>,
): Promise<IntentOutcome<void, ArcRefusal>> {
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
