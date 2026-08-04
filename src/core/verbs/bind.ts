import type {
  BindEntry,
  ContractBody,
  ContractId,
  EntryUlid,
} from "../facts/types.js";
import type { DecideInput, OfferDecision } from "../protocol/run.js";

export type BindInput = Readonly<{
  contractId: ContractId;
  actor: string;
  at: string;
  body: ContractBody;
}>;

export type BindRefusal = Readonly<{
  kind: "contract-already-exists";
  contractId: ContractId;
}>;

function requiredEntryUlid(input: DecideInput<BindInput>): EntryUlid {
  if (!Array.isArray(input.attempt.entryUlids) || input.attempt.entryUlids.length !== 1) {
    throw new TypeError("bind requires exactly one fresh entry ULID");
  }
  return input.attempt.entryUlids[0]!;
}

function cloneBody(body: ContractBody): ContractBody {
  const verification: Array<{ executor: "bash" | "zsh" | "pwsh"; script: string }> = [];
  for (const declaration of body.verification) {
    verification.push({ executor: declaration.executor, script: declaration.script });
  }
  const extensions: Array<{ title: string; content: string }> = [];
  for (const extension of body.extensions) {
    extensions.push({ title: extension.title, content: extension.content });
  }
  return {
    title: body.title,
    context: body.context,
    objective: body.objective,
    design: body.design,
    region: [...body.region],
    criteria: [...body.criteria],
    verification,
    extensions,
  };
}

/** Decide one bind admission from one already-captured protocol observation. */
export function decideBind(input: DecideInput<BindInput>): OfferDecision<null, BindRefusal> {
  const entry = requiredEntryUlid(input);
  const observed = input.observation.contracts.get(input.input.contractId);
  if (observed === undefined) {
    throw new TypeError(`bind contract is not observed: ${input.input.contractId}`);
  }
  if (observed.state !== null) {
    return { kind: "refused", refusal: { kind: "contract-already-exists", contractId: input.input.contractId } };
  }

  const bind: BindEntry = {
    v: 1,
    kind: "bind",
    contract: input.input.contractId,
    entry,
    at: input.input.at,
    actor: input.input.actor,
    data: cloneBody(input.input.body),
  };
  return {
    kind: "offer",
    offer: {
      facts: [{ contractId: input.input.contractId, expectedHead: null, entries: [bind] }],
    },
    handoff: null,
  };
}
