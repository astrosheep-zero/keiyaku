import {
  Keiyaku,
  type ActorId,
  type BindResult,
  type ContractId,
  type Gate,
  type Repo,
  type WorktreeHooks,
} from "../../index.js";
import { bindFromCli } from "../../library/contract-bind.js";
import type { ParsedBind } from "./contract.js";
import { contractFromInput } from "../selectors.js";

type BindCommandInput = Readonly<{
  command: ParsedBind;
  repo: Repo;
  markdown?: string;
  gates?: readonly Gate[];
  actor?: ActorId;
  hooks?: WorktreeHooks;
}>;

export async function bindFromCommand({
  command,
  repo,
  markdown,
  gates,
  actor,
  hooks,
}: BindCommandInput): Promise<BindResult> {
  if (command.forkOf !== undefined) {
    return Keiyaku.with({ ...(actor === undefined ? {} : { actor }), ...(hooks === undefined ? {} : { hooks }) }).bind({
      repo,
      forkOf: contractFromInput(repo, command.forkOf).id,
      ...(command.target === undefined ? {} : { target: command.target }),
    });
  }
  const after: readonly ContractId[] | undefined = command.after?.map((id) => contractFromInput(repo, id).id);
  if (markdown === undefined || gates === undefined) throw new Error("Markdown bind command is missing stdin terms");
  const library = Keiyaku.with();
  return bindFromCli(
    {
      repo,
      markdown,
      ...(command.task === undefined ? {} : { task: command.task as `task/${string}` }),
      ...(command.target === undefined ? {} : { target: command.target }),
      ...(actor === undefined ? {} : { actor }),
      ...(hooks === undefined ? {} : { hooks }),
      ...(after === undefined ? {} : { after }),
      gates,
    },
    (id) => library.select({ repo, id }),
  );
}
