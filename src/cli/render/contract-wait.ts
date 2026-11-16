import type { ContractWaitMember } from "../../library/contract-wait.js";
import { progressStrip } from "./contract-observation.js";
import { safeText } from "./terminal.js";

export function contractWaitMemberText(member: ContractWaitMember): string {
  const facts: string[] = [];
  if (member.presence === "unknown") facts.push("unobserved");
  else if (member.presence === "missing") facts.push("missing");
  else {
    if (member.changed === true) facts.push("changed");
    if (member.terminal !== undefined) facts.push(member.terminal === "claimed" ? "accepted" : "abandoned");
  }
  const head = `${member.id}${facts.length === 0 ? "" : ` (${facts.join(", ")})`}`;
  return member.summary === undefined
    ? head
    : [
        `${head}${member.summary.title === undefined ? "" : ` · ${safeText(member.summary.title)}`}`,
        `  ${progressStrip(member.summary)}`,
      ].join("\n");
}
