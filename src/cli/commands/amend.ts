import { type ActorId, type ContractId, type Gate, type Keiyaku, type Repo } from "../../index.js";
import type { ParsedAmend } from "../parse.js";
import { contractFromInput } from "../selectors.js";

type AmendCommandInput = Readonly<{
  command: ParsedAmend;
  repo: Repo;
  contract: Keiyaku;
  markdown: string;
  gates: readonly Gate[] | undefined;
  actor?: ActorId;
}>;

export function amendFromCommand({ command, repo, contract, markdown, gates, actor }: AmendCommandInput): ReturnType<Keiyaku["amend"]> {
  const after: readonly ContractId[] | undefined = command.clearAfter === true
    ? []
    : command.after?.map((id) => contractFromInput(repo, id).id);
  return contract.amend({
    markdown,
    ...(actor === undefined ? {} : { actor }),
    ...(after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
  });
}
