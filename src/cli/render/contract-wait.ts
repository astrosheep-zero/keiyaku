import type { ContractWaitResult } from "../../library/contract-wait.js";

export function contractWaitText(result: ContractWaitResult): string {
  return `${result.kind}: ${result.contracts
    .map((member) => {
      const facts: string[] = [];
      if (member.present === null) facts.push("unobserved");
      else if (!member.present) facts.push("missing");
      else {
        if (member.changed) facts.push("changed");
        if (member.terminal !== null) facts.push(member.terminal === "claimed" ? "accepted" : "abandoned");
      }
      return `${member.contract}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`;
    })
    .join(", ")}`;
}
