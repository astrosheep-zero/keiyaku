import { decideAbandon, type AbandonRefusal } from "../core/verbs/abandon.js";
import type { GitTreeSelection } from "../git/read-observation.js";
import { admitIntent } from "./intent.js";
import { complete } from "./outcome.js";
import type { CompanionDecorator } from "./run.js";
import type { IntentOutcome, MutationOperationInput } from "./operations.js";
import { timestamp } from "./operations.js";

export async function abandonOperation(
  input: MutationOperationInput & Readonly<{
    note?: string;
    decorateOffer?: CompanionDecorator;
    observationSelection?: GitTreeSelection;
  }>,
): Promise<IntentOutcome<void, AbandonRefusal>> {
  return complete(
    await admitIntent(input.channel, input.scope, {
      contractId: input.contractId,
      ...(input.actor === undefined ? {} : { actor: input.actor }),
      at: timestamp(),
      ...(input.note === undefined ? {} : { note: input.note }),
    }, decideAbandon, {
      ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
      ...(input.observationSelection === undefined ? {} : { observationSelection: input.observationSelection }),
    }),
    undefined,
  );
}
