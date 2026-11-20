import { decideAbandon } from "../core/verbs/abandon.js";
import type { ActiveContractRefusal } from "../core/facts/observation.js";
import type { GitTreeSelection } from "../git/read-observation.js";
import type { CompanionDecorator } from "./run.js";
import { admitVoidIntent, type MutationOperationInput } from "./operations.js";
import type { IntentOutcome } from "./outcome.js";

export async function abandonOperation(
  input: MutationOperationInput &
    Readonly<{
      note?: string;
      decorateOffer?: CompanionDecorator;
      observationSelection?: GitTreeSelection;
    }>,
): Promise<IntentOutcome<void, ActiveContractRefusal>> {
  return admitVoidIntent(input, { ...(input.note === undefined ? {} : { note: input.note }) }, decideAbandon, {
    ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
    ...(input.observationSelection === undefined ? {} : { observationSelection: input.observationSelection }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
  });
}
