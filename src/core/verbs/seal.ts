import type {
  ContractId,
  EntryUlid,
  Phase,
  SealEntry,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type SealInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
}>;

export type SealRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-active"; contractId: ContractId; phase: Phase }>;

function requiredEntryUlid(input: DecideInput<SealInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("seal requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

/** Decide one seal admission from one already-captured protocol observation. */
export function decideSeal(input: DecideInput<SealInput>): OfferDecision<null, SealRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`seal contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state === null) {
    return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.input.contractId } };
  }
  if (observed.state.phase !== "active") {
    return {
      kind: "refused",
      refusal: { kind: "phase-not-active", contractId: input.input.contractId, phase: observed.state.phase },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`seal contract has no observed journal head: ${input.input.contractId}`);
  }

  const seal: SealEntry = {
    v: 1,
    kind: "seal",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: {},
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [seal] }],
    },
    handoff: null,
  };
}
