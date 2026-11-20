import { decideAbandon } from "../core/verbs/abandon.js";
import type { GitTreeSelection } from "../git/read-observation.js";
import type { CompanionDecorator } from "./run.js";
import { admitSimpleIntent, type MutationOperationInput } from "./operations.js";

export async function abandonOperation(
  input: MutationOperationInput &
    Readonly<{
      note?: string;
      decorateOffer?: CompanionDecorator;
      observationSelection?: GitTreeSelection;
    }>,
) {
  return admitSimpleIntent(input, { ...(input.note === undefined ? {} : { note: input.note }) }, decideAbandon, {
    ...(input.decorateOffer === undefined ? {} : { decorateOffer: input.decorateOffer }),
    ...(input.observationSelection === undefined ? {} : { observationSelection: input.observationSelection }),
  });
}
