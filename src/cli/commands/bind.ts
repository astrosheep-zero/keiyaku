import { type ActorId, type BindResult, type ContractId, type KeiyakuLibrary, type Repo } from "../../index.js";
import type { ParsedBind } from "./contract-grammar.js";
import { contractFromInput } from "../selectors.js";

type BindCommandInput = Readonly<{
  command: ParsedBind;
  repo: Repo;
  library: KeiyakuLibrary;
  markdown?: string;
  actor?: ActorId;
}>;

export async function bindFromCommand({
  command,
  repo,
  library,
  markdown,
  actor,
}: BindCommandInput): Promise<BindResult> {
  if (command.forkOf !== undefined) {
    return library.bind({
      repo,
      forkOf: contractFromInput(repo, command.forkOf).id,
      ...(command.target === undefined ? {} : { target: command.target }),
      ...(actor === undefined ? {} : { actor }),
    });
  }
  const after: readonly ContractId[] | undefined = command.after?.map((id) => contractFromInput(repo, id).id);
  if (markdown === undefined) throw new Error("Markdown bind command is missing stdin terms");
  return library.bind({
    repo,
    markdown,
    ...(command.task === undefined ? {} : { task: command.task as `task/${string}` }),
    ...(command.target === undefined ? {} : { target: command.target }),
    ...(actor === undefined ? {} : { actor }),
    ...(after === undefined ? {} : { after }),
    ...(command.gates === undefined ? {} : { gates: command.gates }),
  });
}
