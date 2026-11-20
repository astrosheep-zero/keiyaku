import type { InvocationWaitMember } from "../../library/keiyaku-wait.js";
import { waitStateMark } from "./akuma-activity.js";
import { gateDisplayName } from "./contract-observation.js";
import { safeText } from "./terminal.js";

export function contractWaitMemberText(member: Extract<InvocationWaitMember, { contract: string }>): string {
  const { contract, state, title, gates } = member;
  const head = `${waitStateMark(state)} ${contract}  ${state}${title === undefined ? "" : ` · ${safeText(title)}`}`;
  if (gates === undefined) return head;
  const verdicts = gates.map(({ gate, current }) => `${gateDisplayName(gate)} ${current.replaceAll("-", " ")}`);
  return `${head}\n  ${verdicts.join(" · ")}`;
}
