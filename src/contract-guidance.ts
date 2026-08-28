import type { ArcData, ContractId, ContractState } from "./core/facts/types.js";

const APPOINTMENT_DESCRIPTION = "This is a read-only projection. Do not edit manually.";

export const CONTRACT_DELIVERER_SKILL = [
  "---",
  "name: keiyaku-deliver",
  "description: Operate as the Deliverer for an explicitly appointed Keiyaku Contract worktree.",
  "---",
  "",
  "# Keiyaku Deliverer",
  "",
  "Work and test in the Contract worktree named by the bind receipt. The Contract and its owner documents decide the delivery; this skill is operating guidance only.",
  "",
  "## Deliver",
  "",
  "After the declared verification succeeds, deliver the candidate that is currently in this worktree. A clean worktree delivers HEAD; use `keiyaku deliver <contract> --include-dirty` only when every non-ignored current byte belongs in the candidate.",
  "",
  "Read the delivery receipt. A recorded candidate can wait for review or placement; do not infer lifecycle state from the worktree alone.",
]
  .join("\n")
  .concat("\n");

export const CONTRACT_REVIEWER_SKILL = [
  "---",
  "name: keiyaku-review",
  "description: Operate as the Reviewer for an explicitly appointed Keiyaku Contract worktree.",
  "---",
  "",
  "# Keiyaku Reviewer",
  "",
  "Review the complete current Contract worktree snapshot against its Contract and owner documents. The Contract and its owner documents decide the delivery; this skill is operating guidance only.",
  "",
  "## Review",
  "",
  "Do not modify the worktree. Compare every Contract criterion to the current candidate, report findings by root cause, and distinguish missing evidence from a passing observation.",
  "",
  "When authorized to record the verdict, use `keiyaku review <contract> --satisfied --summary <conclusion>` or `keiyaku review <contract> --unsatisfied --summary <finding>`. Review testimony applies to the current patch and may become stale after it changes.",
]
  .join("\n")
  .concat("\n");

export function renderContractAppointment(contract: ContractId): string {
  return `---\ncontract: ${contract}\ndescription: ${APPOINTMENT_DESCRIPTION}\n---\n`;
}

function renderArc(arc: ArcData): string {
  return [
    "## Arc",
    "",
    "### Sequence",
    "",
    String(arc.seq),
    "",
    "### Title",
    "",
    arc.title.trimEnd(),
    "",
    "### Objective",
    "",
    arc.objective.trimEnd(),
    "",
    "### Brief",
    "",
    arc.brief.trimEnd(),
  ].join("\n");
}

const FULFILLMENT = [
  "## Fulfillment",
  "",
  "### Appointment",
  "",
  "Each commission names exactly one seat: Deliverer or Reviewer.",
  "If no seat was named, stop and ask the caller. Never infer it.",
  "",
  "### Worktree",
  "",
  "This file is a derived view of the journal-authoritative Contract. Never edit it to change the Contract.",
  "Treat the directory containing `.keiyaku/KEIYAKU.md` as the Contract worktree root.",
  "Read the complete Contract before acting and keep work inside that worktree.",
  "Seat operating skills are available at `.agents/skills/keiyaku-deliver/SKILL.md` and `.agents/skills/keiyaku-review/SKILL.md`.",
  "",
  "### Deliverer",
  "",
  "Re-read this file on each wake-up; it may have been updated between sessions.",
  "Implement and verify the Objective under the Design, Region, and Criteria in this Contract.",
  "Region is a rough intent, not a hard boundary — natural ripple outside it is fine and not a blocker.",
  "When an Arc is active, stay within that current chapter.",
  "If you discover a contradiction with this Contract or an unclosed point in its terms,",
  "stop and report it before continuing.",
  "",
  "For work requiring three or more steps, prefer `keiyaku task -C <worktree>` to organize and manage Tasks.",
  "Promptly update progress for Tasks already present in the current worktree.",
  "",
  "Deliver from this worktree. A clean worktree delivers HEAD; uncommitted work",
  "needs `deliver --include-dirty`, which captures the final non-ignored tree and",
  "stages or commits nothing. If deliver reports a conflict, run",
  "`deliver --materialize-conflict`, resolve the conflicted files, and continue",
  "with `deliver --include-dirty` while the merge stays uncommitted. That flag",
  "captures current worktree bytes even when the real index still has unmerged",
  "entries; omitting it still refuses a dirty or unmerged workspace.",
  "",
  "### Reviewer",
  "",
  "Re-read this file on each wake-up; it may have been updated between sessions.",
  "Review the complete current worktree snapshot against this Contract. Do not modify it.",
  "Understand the original intent behind the Objective, not just its literal text.",
  "Region is a rough intent, not a hard boundary — natural ripple outside it is not a blocker.",
  "Compare each Criterion individually against the delivered work.",
  "Consolidate findings by root cause — group symptoms that share an underlying issue",
  "rather than listing each occurrence separately.",
  "Dig to the architectural or structural root; flag it directly rather than routing around it.",
  "If you discover a contradiction within the Contract or an unclosed point in its terms,",
  "report it as a finding.",
  "Report covered Criteria, findings, and missing evidence.",
].join("\n");

export function renderContractGuidance(state: ContractState): string {
  return [
    renderContractAppointment(state.id).trimEnd(),
    state.terms.document.bytes.trimEnd(),
    ...(state.currentArc === undefined ? [] : [renderArc(state.currentArc.data)]),
    FULFILLMENT,
  ]
    .join("\n\n")
    .concat("\n");
}
