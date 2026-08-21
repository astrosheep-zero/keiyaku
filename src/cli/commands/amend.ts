import { type ActorId, type ContractId, type Gate, type Keiyaku, type Repo, type WorktreeHooks } from "../../index.js";
import type { ParsedAmend } from "./contract.js";
import { contractFromInput } from "../selectors.js";

type AmendCommandInput = Readonly<{
  command: ParsedAmend;
  repo: Repo;
  contract: Keiyaku;
  markdown?: string;
  gates: readonly Gate[] | undefined;
  actor?: ActorId;
  hooks?: WorktreeHooks;
}>;

export function amendFromCommand({
  command,
  repo,
  contract,
  markdown,
  gates,
  actor,
  hooks,
}: AmendCommandInput): ReturnType<Keiyaku["amend"]> {
  const after: readonly ContractId[] | undefined =
    command.clearAfter === true ? [] : command.after?.map((id) => contractFromInput(repo, id).id);
  return contract.amend({
    ...(markdown === undefined ? {} : { markdown }),
    ...(actor === undefined ? {} : { actor }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
  });
}
