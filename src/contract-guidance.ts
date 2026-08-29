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
  "The Deliverer implements and verifies the appointed Contract in its worktree. Repository authority decides delivery semantics; the Contract selects scope, terms, and evidence. This skill is operating guidance only.",
  "",
  "## Common Workflow",
  "",
  "Read the complete `KEIYAKU.md`, the named authority documents, and the Region before editing. Keep implementation and focused verification inside the appointed worktree. Private decomposition, helper names, and equivalent control flow are yours unless the Contract explicitly pins them.",
  "",
  "A dispatch brief may prioritize attention, point to evidence, and ask questions. It cannot add or change acceptance terms, prescribe an unsettled mechanism, or resolve an open design choice. If authority and a term conflict, a criterion lacks grounding in authority or a constructible current failure, or a public or architectural choice remains open, stop and report the gap; continue only after a journaled amendment settles it.",
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
  "Judge whether the complete current candidate satisfies every adjudicable Contract term under repository authority. The Contract selects scope, terms, and evidence; this skill is operating guidance only.",
  "",
  "## Common Workflow",
  "",
  "Do not modify the worktree. Read the complete Contract, authority documents, and current snapshot before judging it. Inspect the full current tree, not only a reported diff. A dispatch brief may prioritize attention, point to evidence, and ask questions; it cannot narrow the verdict basis, add acceptance terms, prescribe a finding, or require you to re-prove an earlier judgment.",
  "",
  "Understand the original intent behind the Objective, not only its literal wording.",
  "Region is a rough intent, not a hard boundary. Natural ripple outside the Region is not a finding by itself.",
  "Before applying a Criterion, trace it to repository authority or a constructible current failure. A conflicting, undefined, or ungrounded term, including one justified only by a hypothetical future source edit, is a term defect: stop candidate judgment for that term, report it without recording a verdict, and wait for a journaled amendment.",
  "",
  "Only a current candidate defect against authority or a grounded term, or missing, failed, or stale required evidence, can block the candidate. Unbound simplification, duplication, architecture, and future-change observations are nonblocking risks in the summary.",
  "",
  "Consolidate findings by root cause and cite exact files and evidence. A repeat review re-judges the complete current candidate from authority; closing an earlier finding is only one check. When the same root cause produces a second unsatisfied review, put the Criterion on trial instead of demanding a stronger candidate mechanism.",
  "",
  "## Review",
  "",
  "When authorized, use `keiyaku review <contract> --satisfied --summary <conclusion>` only when every term is adjudicable and no blocking defect or evidence gap remains. Use `keiyaku review <contract> --unsatisfied --summary <finding>` only for a blocking current defect or required-evidence failure. A term defect receives a report, not a review receipt. Review testimony applies to the current patch and may become stale after it changes.",
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
  "Compare each adjudicable Criterion individually against the delivered work; the Reviewer seat defines adjudicability.",
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
