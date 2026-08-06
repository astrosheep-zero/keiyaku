import type { Offer } from "./facts/offer.js";
import type { ContractsObservation } from "./facts/observation.js";
import type { EntryUlid } from "./facts/types.js";

export type AttemptContext = Readonly<{
  ordinal: number;
  entryUlids: readonly EntryUlid[];
}>;

export type DecideInput<Input> = Readonly<{
  input: Input;
  attempt: AttemptContext;
  observation: ContractsObservation;
}>;

export type OfferDecision<Refusal> =
  | Readonly<{ kind: "offer"; offer: Offer }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;
