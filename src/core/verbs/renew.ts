import type {
  ContractId,
  EntryUlid,
  Phase,
  RenewEntry,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type RenewInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  newBase: RenewEntry["data"]["newBase"];
  oldHead: RenewEntry["data"]["oldHead"];
  newHead: RenewEntry["data"]["newHead"];
}>;

export type RenewRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-sealed"; contractId: ContractId; phase: Phase }>
  | Readonly<{ kind: "delivery-missing"; contractId: ContractId }>
  | Readonly<{
    kind: "delivery-head-mismatch";
    contractId: ContractId;
    oldHead: RenewEntry["data"]["oldHead"];
    observedHead: RenewEntry["data"]["oldHead"];
  }>;

function requiredEntryUlid(input: DecideInput<RenewInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("renew requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

/** Decide one delivery renewal from one already-captured protocol observation. */
export function decideRenew(input: DecideInput<RenewInput>): OfferDecision<null, RenewRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`renew contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state === null) {
    return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.input.contractId } };
  }
  if (observed.state.phase !== "sealed") {
    return {
      kind: "refused",
      refusal: { kind: "phase-not-sealed", contractId: input.input.contractId, phase: observed.state.phase },
    };
  }
  if (observed.state.delivery === null) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId: input.input.contractId } };
  }
  if (input.input.oldHead !== observed.state.delivery.head) {
    return {
      kind: "refused",
      refusal: {
        kind: "delivery-head-mismatch",
        contractId: input.input.contractId,
        oldHead: input.input.oldHead,
        observedHead: observed.state.delivery.head,
      },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`renew contract has no observed journal head: ${input.input.contractId}`);
  }

  const renew: RenewEntry = {
    v: 1,
    kind: "renew",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: {
      newBase: input.input.newBase,
      oldHead: input.input.oldHead,
      newHead: input.input.newHead,
    },
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [renew] }],
    },
    handoff: null,
  };
}
