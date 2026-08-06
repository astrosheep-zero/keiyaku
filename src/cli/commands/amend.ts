import { type ActorId, type ContractId, type Gate, type Keiyaku, type Outcome } from "../../index.js";
import type { ParsedAmend } from "../parse.js";
import { contractIdentity } from "../selectors.js";

export function amendFromCommand(
  command: ParsedAmend,
  contract: Keiyaku,
  markdown: string,
  gates: readonly Gate[] | undefined,
  actor?: string,
): Promise<Outcome<void>> {
  const after: readonly ContractId[] | undefined = command.clearAfter === true
    ? []
    : command.after?.map(contractIdentity);
  return contract.amend({
    markdown,
    ...(actor === undefined ? {} : { actor: actor as ActorId }),
    ...(after === undefined ? {} : { after }),
    ...(gates === undefined ? {} : { gates }),
  });
}
