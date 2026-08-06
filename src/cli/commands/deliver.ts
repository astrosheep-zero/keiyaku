import { type ActorId, type Delivery, type Keiyaku, type Outcome } from "../../index.js";
import type { ParsedDeliver } from "../parse.js";

export function deliverFromCommand(
  _command: ParsedDeliver,
  contract: Keiyaku,
  actor?: string,
): Promise<Outcome<Delivery>> {
  return contract.deliver(actor === undefined ? {} : { actor: actor as ActorId });
}
