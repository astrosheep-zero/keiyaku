import type {
  AmendData,
  AmendEntry,
  ContractId,
  CriteriaDelta,
  EntryUlid,
  Phase,
  SectionRevision,
  VerificationDeclaration,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type AmendInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  data: AmendData;
}>;

export type AmendRefusal =
  | Readonly<{ kind: "contract-missing"; contractId: ContractId }>
  | Readonly<{ kind: "phase-not-amendable"; contractId: ContractId; phase: Phase }>;

function requiredEntryUlid(input: DecideInput<AmendInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("amend requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

function cloneAmendData(data: AmendData): AmendData {
  const copy: {
    revisions?: SectionRevision[];
    region?: string[];
    criteriaDelta?: CriteriaDelta;
    verificationDelta?: { replace: VerificationDeclaration[] };
  } = {};

  if (data.revisions !== undefined) {
    const revisions: SectionRevision[] = [];
    for (const revision of data.revisions) {
      const target = typeof revision.target === "string"
        ? revision.target
        : { extension: revision.target.extension };
      revisions.push({ target, op: revision.op, body: revision.body });
    }
    copy.revisions = revisions;
  }
  if (data.region !== undefined) copy.region = [...data.region];
  if (data.criteriaDelta !== undefined) {
    copy.criteriaDelta = "add" in data.criteriaDelta
      ? { add: [...data.criteriaDelta.add] }
      : { replace: [...data.criteriaDelta.replace] };
  }
  if (data.verificationDelta !== undefined) {
    const replace: VerificationDeclaration[] = [];
    for (const declaration of data.verificationDelta.replace) {
      replace.push({ executor: declaration.executor, script: declaration.script });
    }
    copy.verificationDelta = { replace };
  }
  return copy;
}

function amendable(phase: Phase): boolean {
  return phase === "active" || phase === "awaiting-verdict" || phase === "approved";
}

/** Decide one amend admission from one already-captured protocol observation. */
export function decideAmend(input: DecideInput<AmendInput>): OfferDecision<null, AmendRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`amend contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state === null) {
    return { kind: "refused", refusal: { kind: "contract-missing", contractId: input.input.contractId } };
  }
  if (!amendable(observed.state.phase)) {
    return {
      kind: "refused",
      refusal: { kind: "phase-not-amendable", contractId: input.input.contractId, phase: observed.state.phase },
    };
  }
  if (observed.state.head === null) {
    throw new TypeError(`amend contract has no observed journal head: ${input.input.contractId}`);
  }

  const amend: AmendEntry = {
    v: 1,
    kind: "amend",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: cloneAmendData(input.input.data),
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: observed.state.head, entries: [amend] }],
    },
    handoff: null,
  };
}
