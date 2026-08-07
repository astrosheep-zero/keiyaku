import type { Offer } from "./facts/offer.js";
import type { ContractsObservation } from "./facts/observation.js";
import type { DocumentKey, EntryUlid } from "./facts/types.js";

export type AttemptContext = Readonly<{
  entryUlids: readonly EntryUlid[];
}>;

export type DecideInput<Input> = Readonly<{
  input: Input;
  attempt: AttemptContext;
  observation: ContractsObservation;
}>;

/** The protocol's mechanical or declaration result supplied to a legal decision. */
export type Preparation<Data, Refusal> = Readonly<
  | { kind: "prepared"; data: Data; refusal?: never }
  | { kind: "refused"; refusal: Refusal; data?: never }
>;

/** A document-derived preparation whose stamp is unavailable only with contract absence. */
export type StampedPreparation<Data, Refusal> = Readonly<
  | { kind: "unavailable"; document?: never; data?: never; refusal?: never }
  | { kind: "prepared"; document: DocumentKey; data: Data; refusal?: never }
  | { kind: "refused"; document: DocumentKey; refusal: Refusal; data?: never }
>;

export type OfferDecision<Refusal> =
  | Readonly<{ kind: "offer"; offer: Offer }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;
