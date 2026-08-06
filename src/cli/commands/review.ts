import { type ActorId, type ContractId, type Keiyaku, type Outcome } from "../../index.js";
import type { ParsedReview } from "../parse.js";

export async function reviewFromCommand(
  command: ParsedReview,
  contractId: ContractId,
  contract: Keiyaku,
  actor?: string,
): Promise<Outcome<void>> {
  const delivery = await contract.delivery();
  if (delivery === null) {
    return { kind: "refused", refusal: { kind: "delivery-missing", contractId } };
  }
  return delivery.review(command.verdict, {
    ...(actor === undefined ? {} : { actor: actor as ActorId }),
    ...(command.summary === undefined ? {} : { summary: command.summary }),
  });
}
