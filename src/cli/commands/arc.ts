import { type ActorId, type Keiyaku, type Outcome } from "../../index.js";
import type { ParsedArc } from "../parse.js";

export function arcFromCommand(
  _command: ParsedArc,
  contract: Keiyaku,
  markdown: string,
  actor?: string,
): Promise<Outcome<void>> {
  return contract.arc({ markdown, ...(actor === undefined ? {} : { actor: actor as ActorId }) });
}
