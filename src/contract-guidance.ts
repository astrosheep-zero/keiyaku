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
  "The Deliverer implements and verifies the appointed Contract in its worktree. The Contract and its owner documents decide the delivery; this skill is operating guidance only.",
  "",
  "## Common Workflow",
  "",
  "Read the complete `KEIYAKU.md`, the named owner documents, and the Region before editing. Keep implementation and focused verification inside the appointed worktree, and stop when the Contract or owner law leaves a public or architectural choice open.",
  "",
  "For work requiring three or more steps, use `keiyaku task -C <worktree>` and update Tasks already present. Run the Contract's focused verification, then typecheck and build when declared.",
  "",
  "## Deliver",
  "",
  "After verification succeeds, deliver the candidate in this worktree. A clean worktree delivers HEAD; use `keiyaku deliver <contract> --include-dirty` only when every non-ignored current byte belongs in the candidate.",
  "",
  "Read the delivery receipt. A recorded candidate can wait for review or placement; do not infer lifecycle state from the worktree alone.",
  "",
  "If delivery reports a conflict, run `keiyaku deliver <contract> --materialize-conflict`, resolve the conflicted files, and deliver again with `--include-dirty`. The flag captures current bytes without staging or committing.",
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
  "## Common Workflow",
  "",
  "Do not modify the worktree. Read the complete Contract, owner documents, and current snapshot before judging it. Compare every Criterion individually and inspect the full current tree, not only a reported diff.",
  "",
  "Consolidate findings by root cause, cite exact files and evidence, and distinguish a missing proof from a passing observation. Treat testimony as scoped to the current patch; any patch change makes prior review evidence stale.",
  "",
  "## Review",
  "",
  "When authorized to record the verdict, use `keiyaku review <contract> --satisfied --summary <conclusion>` or `keiyaku review <contract> --unsatisfied --summary <finding>`. Review testimony applies to the current patch and may become stale after it changes.",
  "",
  "Report covered Criteria, root-cause findings, and missing evidence. Do not edit the candidate to make a finding disappear.",
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
  "Seat-specific operating skills are available in this worktree.",
  "",
  "### Deliverer",
  "",
  "Implement and verify the Objective under the Design, Region, and Criteria in this Contract.",
  "When an Arc is active, stay within that current chapter.",
  "If you discover a contradiction or unclosed term, stop and report it before continuing.",
  "Read the Deliverer operating procedures at `.agents/skills/keiyaku-deliver/SKILL.md`.",
  "",
  "### Reviewer",
  "",
  "Review the complete current worktree snapshot against this Contract. Do not modify it.",
  "Compare each Criterion individually against the delivered work.",
  "Consolidate findings by root cause — group symptoms that share an underlying issue",
  "rather than listing each occurrence separately.",
  "Report covered Criteria, findings, and missing evidence.",
  "Read the Reviewer operating procedures at `.agents/skills/keiyaku-review/SKILL.md`.",
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
