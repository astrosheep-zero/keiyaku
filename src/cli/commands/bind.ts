import { Keiyaku, type ActorId, type BindResult, type ContractId, type Gate } from "../../index.js";
import type { ParsedBind } from "../parse.js";
import { contractIdentity } from "../selectors.js";

export function bindFromCommand(
  command: ParsedBind,
  markdown: string,
  repoPath: string | undefined,
  gates: readonly Gate[],
  actor?: string,
): Promise<BindResult> {
  const after: readonly ContractId[] | undefined = command.after?.map(contractIdentity);
  return Keiyaku.bind({
    markdown,
    ...(repoPath === undefined ? {} : { repo: repoPath }),
    ...(command.target === undefined ? {} : { target: command.target }),
    ...(command.workspace === undefined ? {} : { workspace: command.workspace }),
    ...(actor === undefined ? {} : { actor: actor as ActorId }),
    ...(after === undefined ? {} : { after }),
    gates,
  });
}
