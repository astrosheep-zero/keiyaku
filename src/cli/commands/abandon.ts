import { type ActorId, type Keiyaku, type Outcome } from "../../index.js";
import type { ParsedAbandon } from "../parse.js";

export function abandonFromCommand(
  _command: ParsedAbandon,
  contract: Keiyaku,
  actor?: string,
): Promise<Outcome<void>> {
  return contract.abandon("manual", {
    ...(actor === undefined ? {} : { actor: actor as ActorId }),
  });
}
