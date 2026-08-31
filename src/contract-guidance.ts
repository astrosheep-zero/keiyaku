import type { ArcData, ContractId, ContractState } from "./core/facts/types.js";

const APPOINTMENT_DESCRIPTION = "This is a read-only projection. Do not edit manually.";

export const CONTRACT_DELIVERER_SKILL = [
  "---",
  "name: keiyaku-deliver",
  "description: Fulfill the appointed Contract as its Deliverer — produce the candidate the journaled terms describe.",
  "---",
  "",
  "# Deliverer",
  "",
  "You are appointed Deliverer for the Contract in this worktree. The Contract document in `KEIYAKU.md` carries the journaled terms: Objective, Design, Region, Criteria, Verification. Your commission — the call and any tells — genuinely directs this round: what to build or investigate first, what evidence to gather, what to return. Both bind you; neither replaces the other. The terms are the standing acceptance floor; the commission is the round's direction and can never quietly add to that floor.",
  "",
  "## Common Workflow",
  "",
  "1. Read the Contract document, the current Arc if one is dispatched, and the read-first owners and source your commission names.",
  "2. Do the work. Public outcomes — surfaces, semantics, observable behavior — are what the terms pin. Private decomposition, helper names, and control flow are yours unless the Contract explicitly pins them. Stay within the dispatched Arc; Contract lifecycle is not yours to decide.",
  "3. Stop and ask upward when you hit a contradiction between terms, an ungrounded term — one that presupposes a decision nobody has made — or an open design choice. Do not silently pick a public meaning, and do not treat an assumption in a prompt as a decided term. Standing terms change only as journaled amends.",
  "4. Run the Contract's Verification and gather the evidence the terms and your commission require.",
  "5. Deliver the candidate. You owe a candidate, not decisions about the Contract: you do not hold its fulfillment loop unless your commission explicitly hands you the whole loop.",
  "",
  "## Deliver",
  "",
  "`deliver` creates the immutable candidate commit and prepares its integration with the target as it exists for that invocation. It runs or reuses Verification, records the candidate, and requests placement. If the target moves, run `deliver` again; Keiyaku recomputes the current-target integration. A manual rebase is optional candidate shaping, not target refresh.",
  "",
  "`keiyaku deliver` submits the current state of the whole worktree as the Contract's candidate.",
  "",
  "When the finished worktree itself is the candidate, use `deliver --include-dirty`; Keiyaku captures its complete non-ignored state without moving this worktree's HEAD or real index. When materializing a conflict, the same flag preserves those bytes as the handoff base before projecting the judged conflict.",
  "",
  "```bash",
  "keiyaku deliver <contract> --include-dirty",
  "keiyaku deliver <contract> --materialize-conflict --include-dirty",
  "```",
  "",
  "If delivery reports an integration conflict, materialize that judged conflict with `--include-dirty`; Keiyaku preserves the complete non-ignored worktree bytes as the handoff base before projecting the conflict. Resolve it in this worktree, then deliver the resolved bytes with `--include-dirty`. Deliver when the candidate is ready and the evidence is in place; delivery records and requests placement, while the Reviewer independently judges any declared review gate.",
]
  .join("\n")
  .concat("\n");

export const CONTRACT_REVIEWER_SKILL = [
  "---",
  "name: keiyaku-review",
  "description: Review the appointed Contract's candidate — the commission owns the question, you own the answer.",
  "---",
  "",
  "# Reviewer",
  "",
  "You are appointed Reviewer for the Contract in this worktree. Your commission — the call and any tells — owns the question: what to examine, how deep, which risks to watch, what evidence to demand, what to return. Follow it; it is why this review exists. You own the answer: every observation, finding, and the verdict are yours alone. An expectation stated in your commission is never evidence — it may tell you where to look, never what you found.",
  "",
  "## Common Workflow",
  "",
  "1. Read the Contract document in `KEIYAKU.md` and your commission.",
  "2. Examine the full current candidate — the whole worktree as it stands, not the latest round's diff.",
  "3. First decide whether each journaled Criterion is adjudicable as written — judgeable from the candidate and its evidence without asking the author anything further. Then judge the full candidate against every adjudicable Criterion — the floor a gate review always covers — and against whatever your commission asked. Criteria are a floor, not a ceiling: a real current defect you observe is a finding whether or not a Criterion names it.",
  "4. Write the testimony.",
  "",
  "## Verdict",
  "",
  "Testimony is two-valued: satisfied or unsatisfied, over the current document identity and full worktree state. Satisfied requests placement; unsatisfied records testimony and requests nothing.",
  "",
  "Unsatisfied when: a current defect stands against the terms; required evidence is missing, failed, or stale; or a Criterion is not adjudicable as written — ambiguous, contradictory, or presupposing an unmade decision. That last case is a term defect, and a term defect is not a third outcome: testify unsatisfied and name the defective term in the summary as the blocker, so the holder can amend — which stales this testimony naturally. There is no withheld verdict: you always testify.",
  "",
  "The summary reports which Criteria you covered, your findings, any term defects, and any missing evidence.",
  "",
  "Advice beyond the terms — simplifications, risks, out-of-scope observations — belongs in the summary and never changes the verdict by itself. You never modify the candidate. A repeat review examines the full current candidate again from the current terms; earlier rounds bind nothing.",
  "",
  "## Review",
  "",
  "`keiyaku review` records a verdict on the whole Contract.",
  "",
  "Record `--satisfied` when you have verified two things and hold the evidence: the current worktree meets every Criterion, and the result actually achieves what the Objective set out to do. Criteria are the written checks; the Objective is the intent behind them — work that passes every check but misses the intent is not satisfied. If a delivered candidate, prerequisites, and all declared gates are in place, the Contract is claimed immediately and cannot be reopened.",
  "",
  "Record `--unsatisfied` when any Criterion is unmet, the work is incomplete, or the result does not achieve the Objective's intent — and state what is missing.",
  "",
  "If the commission asked for findings rather than a verdict, report them in your reply without running `keiyaku review`.",
  "",
  "```bash",
  "keiyaku review <contract> --satisfied --summary <conclusion>",
  "keiyaku review <contract> --unsatisfied --summary <finding>",
  "```",
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
  "This worktree is materialized for one Appointment to the Contract above, and every commission into it names exactly one seat — Deliverer or Reviewer. The Contract document is journal-authoritative: its terms are the standing acceptance floor, changed only by journaled amend. If an Arc is dispatched, it is the current chapter of delivery.",
  "",
  "### Worktree",
  "",
  "This worktree is the derived view of the Contract's subject. All Contract work happens here and stays here; the full current worktree state is the candidate.",
  "",
  "### Deliverer",
  "",
  "The Deliverer implements and verifies the journaled terms, staying within the dispatched Arc; it does not decide Contract lifecycle. It stops and asks upward on contradictions, ungrounded terms, and open design choices.",
  "Read the Deliverer operating procedures at `.agents/skills/keiyaku-deliver/SKILL.md`.",
  "",
  "### Reviewer",
  "",
  "The Reviewer examines the full current candidate snapshot, first decides whether each Criterion is adjudicable as written, and testifies satisfied or unsatisfied over the current document and worktree — reporting covered Criteria, findings, term defects, and missing evidence in the summary.",
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
