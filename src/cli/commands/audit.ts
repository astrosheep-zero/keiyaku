import type { ActorId, AuditReport, Keiyaku, Outcome } from "../../index.js";
import type { ParsedAudit } from "../parse.js";

export function auditFromCommand(
  _command: ParsedAudit,
  contract: Keiyaku,
  actor?: string,
): Promise<Outcome<AuditReport>> {
  return contract.audit(actor === undefined ? {} : { actor: actor as ActorId });
}
