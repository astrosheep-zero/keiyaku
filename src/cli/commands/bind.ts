import { Keiyaku, type ActorId, type BindResult, type ContractId, type Gate, type Repo, type WorktreeHooks } from "../../index.js";
import type { ParsedBind } from "./contract.js";
import { contractFromInput } from "../selectors.js";

type BindCommandInput = Readonly<{
  command: ParsedBind;
  repo: Repo;
  markdown: string;
  gates: readonly Gate[];
  actor?: ActorId;
  hooks?: WorktreeHooks;
}>;

export async function bindFromCommand({ command, repo, markdown, gates, actor, hooks }: BindCommandInput): Promise<BindResult> {
  const after: readonly ContractId[] | undefined = command.after?.map((id) => contractFromInput(repo, id).id);
  const target = command.target ?? await repo.currentBranch();
  return Keiyaku.bind({
    repo,
    markdown,
    ...(command.task === undefined ? {} : { task: command.task as `task/${string}` }),
    ...(target === null ? {} : { target }),
    ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
    ...(actor === undefined ? {} : { actor }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(after === undefined ? {} : { after }),
    gates,
  });
}
