import { type ActorId, type ContractId, type Keiyaku, type Repo } from "../../index.js";
import type { ParsedAmend } from "./contract-grammar.js";
import { contractFromInput } from "../selectors.js";

type AmendCommandInput = Readonly<{
  command: ParsedAmend;
  repo: Repo;
  contract: Keiyaku;
  markdown?: string;
  gates?: readonly string[];
  actor?: ActorId;
}>;

export function amendFromCommand({
  command,
  repo,
  contract,
  markdown,
  gates,
  actor,
}: AmendCommandInput): ReturnType<Keiyaku["amend"]> {
  const after: readonly ContractId[] | undefined =
    command.clearAfter === true ? [] : command.after?.map((id) => contractFromInput(repo, id).id);
  return contract.amend({
    ...(markdown === undefined ? {} : { markdown }),
    ...(actor === undefined ? {} : { actor }),
    ...(after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
  });
}
