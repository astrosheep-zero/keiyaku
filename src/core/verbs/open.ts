import type {
  ContractId,
  EntryUlid,
  OpenEntry,
  Phase,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type OpenInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  target: OpenEntry["data"]["target"];
  base: OpenEntry["data"]["base"];
}>;

export type OpenRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-active"; contractId: ContractId; phase: Phase }>
  | Readonly<{ kind: "delivery-already-installed"; contractId: ContractId }>;

function requiredEntryUlid(input: DecideInput<OpenInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("open requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

/** Decide the first delivery installation from one already-captured protocol observation. */
export function decideOpen(input: DecideInput<OpenInput>): OfferDecision<null, OpenRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`open contract is not observed: ${input.input.contractId}`);
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
  if (observed.state.delivery !== null) {
    return {
      kind: "refused",
      refusal: { kind: "delivery-already-installed", contractId: input.input.contractId },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`open contract has no observed journal head: ${input.input.contractId}`);
  }

  const open: OpenEntry = {
    v: 1,
    kind: "open",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: {
      target: input.input.target,
      base: input.input.base,
    },
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [open] }],
    },
    handoff: null,
  };
}
