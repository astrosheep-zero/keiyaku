import type {
  ContractId,
  EntryUlid,
  ForfeitData,
  ForfeitEntry,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type ForfeitInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  data: ForfeitData;
}>;

export type ForfeitRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-forfeitable"; contractId: ContractId; phase: "claimed" | "forfeited" }>;

function requiredEntryUlid(input: DecideInput<ForfeitInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("forfeit requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

function cloneForfeitData(data: ForfeitData): ForfeitData {
  return data.note === undefined
    ? { reason: data.reason }
    : { reason: data.reason, note: data.note };
}

/** Decide one forfeit admission from one already-captured protocol observation. */
export function decideForfeit(input: DecideInput<ForfeitInput>): OfferDecision<null, ForfeitRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`forfeit contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state === null) {
    return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.input.contractId } };
  }
  if (observed.state.phase === "claimed" || observed.state.phase === "forfeited") {
    return {
      kind: "refused",
      refusal: { kind: "phase-not-forfeitable", contractId: input.input.contractId, phase: observed.state.phase },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`forfeit contract has no observed journal head: ${input.input.contractId}`);
  }

  const forfeit: ForfeitEntry = {
    v: 1,
    kind: "forfeit",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: cloneForfeitData(input.input.data),
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [forfeit] }],
    },
    handoff: null,
  };
}
