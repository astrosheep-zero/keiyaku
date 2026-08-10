import { Keiyaku, type ActorId, type BindResult, type ContractId, type Gate, type Repo } from "../../index.js";
import type { ParsedBind } from "../parse.js";
import { contractFromInput } from "../selectors.js";

export async function bindFromCommand(
  command: ParsedBind,
  repo: Repo,
  markdown: string,
  gates: readonly Gate[],
  actor?: ActorId,
): Promise<BindResult> {
  const after: readonly ContractId[] | undefined = command.after?.map((id) => contractFromInput(repo, id).id);
  const target = command.target ?? await repo.currentBranch();
  return Keiyaku.bind({
    repo,
    markdown,
    ...(target === null ? {} : { target }),
    ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
    ...(actor === undefined ? {} : { actor }),
    ...(after === undefined ? {} : { after }),
    gates,
  });
}
