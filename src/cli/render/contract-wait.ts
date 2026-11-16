import type { ContractWaitMember } from "../../library/contract-wait.js";

export function contractWaitMemberText(member: ContractWaitMember): string {
  const facts: string[] = [];
  if (member.presence === "unknown") facts.push("unobserved");
  else if (member.presence === "missing") facts.push("missing");
  else {
    if (member.changed === true) facts.push("changed");
    if (member.terminal !== undefined) facts.push(member.terminal === "claimed" ? "accepted" : "abandoned");
  }
  return `${member.id}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`;
}
