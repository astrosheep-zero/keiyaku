import type { ContractWaitResult } from "../../library/contract-wait.js";

export function contractWaitText(result: ContractWaitResult): string {
  return `${result.kind}: ${result.contracts
    .map(
      (member) =>
        `${member.contract}${member.present === null ? " (unobserved)" : member.present === false ? " (missing)" : member.changed ? " (changed)" : ""}`,
    )
    .join(", ")}`;
}
