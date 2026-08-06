import type { Offer } from "./facts/offer.js";
import type { ContractsObservation } from "./facts/observation.js";
import type { EntryUlid } from "./facts/types.js";

export type AttemptContext = Readonly<{
  ordinal: number;
  entryUlids: readonly EntryUlid[];
}>;

export type AttemptCollision = Readonly<{
  contractId: import("./facts/types.js").ContractId;
  planned: import("./facts/types.js").JournalEntry;
  observed: import("./facts/types.js").JournalEntry;
  plannedBytes: string;
  observedBytes: string;
}>;

export type DecideInput<Input> = Readonly<{
  input: Input;
  attempt: AttemptContext;
  observation: ContractsObservation;
  collision?: AttemptCollision;
}>;

export type OfferDecision<Handoff, Refusal> =
  | Readonly<{ kind: "offer"; offer: Offer; handoff: Handoff }>
  | Readonly<{ kind: "refused"; refusal: Refusal }>;
