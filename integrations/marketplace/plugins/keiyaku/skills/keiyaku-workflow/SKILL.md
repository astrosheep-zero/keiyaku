---
name: keiyaku-workflow
description: >-
  Must read before binding a `kei` (Contract) or when acting as its holder.
  Use when deciding when to bind a kei, how to shape and hold it, how to
  delegate its work, and how to accept, amend, or end it.
---

# Keiyaku Workflow

The holder runs one Contract's fulfillment loop from preparation to completion.

## 1. Prepare Before Binding

Before `bind`, settle the information that makes the `kei` truthful:

- objective and intended outcome;
- design and approach;
- affected Region;
- acceptance conditions;
- verification and required evidence;
- prerequisites;
- holder.

If the design, approach, or acceptance conditions are still open, do not bind.
Resolve them with their owner first. Private implementation details may remain
for the Deliverer; the public meaning and acceptance boundary may not.

Bind independent `kei`s in parallel. Do not split one acceptance boundary just
to create parallel work.

## 2. Split the Work

- Separate `kei`s have independently acceptable outcomes.
- An Arc is a chapter of one `kei`; it is not separately accepted.
- A Task stores decomposition or dependencies that outlive this conversation.

Use `after` only when one `kei` requires another to be claimed first. Ordinary
overlap is not a dependency.

## 3. Hold the `kei`

Every `kei` has exactly one holder. The holder coordinates the work and owns
acceptance until claim or abandonment. Delegation does not transfer that
responsibility. An Akuma holding the whole loop needs the `kei`, current Arc
when one exists, appointed worktree, holder duties, and actions its commission
will perform. Birth freezes permissions; Contract association grants none.

## 4. Lifecycle

Each act changes a different part of the world:

- **Bind:** Journal gains the Contract and its terms. Workspace appointment
  names one managed worktree; the receipt reports its path. Appointment lag
  leaves the bind admitted without a path and reports pending reconciliation.
  `reconcile` retries workspace realization.
- **Work:** Changes and commits belong in the appointed worktree. Another
  lane's claim can move the target beneath it. Check target movement before
  audit; when it matters, merge the target branch (main when selected) in the
  worktree and resolve conflicts there before auditing.
- **Audit:** Previews the candidate and target without tendering or claiming.
  Declared Verification can record a `verified` attestation for the captured
  subject; current evidence is reused. No declaration or a stopped run records
  no new verdict.
- **Deliver:** Captures a tender and integration against the observed target;
  journal gains a delivered candidate. Ready prerequisites and gates trigger
  placement and claim in this invocation; otherwise the candidate waits.
  Changed candidate content stales earlier review. Identical content retains
  review across rebase or target movement.
- **Review:** Records verdict evidence for the current document and worktree
  content, even before delivery. Satisfied review requests placement: with a
  delivered candidate, current gates, and ready prerequisites, it claims in
  this invocation. Unsatisfied review records testimony without placement.
- **Abandon:** Records the alternate terminal outcome without claiming. Claimed
  and abandoned Contracts cannot be reopened.

Placement judges declared gates, not the producer's identity. Review does not
replace Verification; audit never requests placement. Read the final receipt
for stops and reconciliation lag after an admitted act.

## 5. Seats And Capabilities

This is the one commissioning map. `call --help` owns the exact action
vocabulary and default set. `--contract` records association, not authority.

| Seat | Grant and commission | Return |
| --- | --- | --- |
| Holder | Direct flagship commands need no Akuma grant. A delegated holder gets only its birth-time actions; include review when the delegated loop records review. | Own the acceptance loop and inspect receipts. |
| Deliverer | The ordinary baseline includes every Task mutation, Contract audit and delivery, and Akuma management. `keiyaku -C <repo> call worker --alias @deliverer --contract <kei/...> --workdir <appointed-path> -` | Produce and tender the candidate; return the receipt. |
| Reviewer | Add `--allowed contract.review` at birth: `keiyaku -C <repo> call review-akuma --alias @reviewer --contract <kei/...> --workdir <appointed-path> --allowed contract.review -` | Record a verdict and return its receipt. Without the grant, `not-allowed` refuses the mutation; no Contract verdict is recorded. |

An Archetype's explicit allowed set replaces the ordinary baseline. Check
`status` for effective actions. `tell` and `fork` cannot add a grant to a live
Akuma; call a fresh one with the grant. Nested calls cannot exceed their direct
parent's actions.

## 6. Delegate the Work

Commission with a clear objective, current Arc when one exists, appointed
worktree, and expected result. A Deliverer produces the candidate. A Reviewer
checks the complete Contract against its acceptance conditions and returns
verdict evidence. Use `keiyaku-akuma` for invocation and observation, and
command help for exact syntax.

## 7. Decide What Happens Next

The holder checks candidate, verification, review, prerequisites, and gates.

- A ready delivered candidate claims automatically on delivery or satisfied
  review; no separate claim command is needed.
- Missing evidence or unfinished work calls for another commission or chapter.
- Amend when the objective and acceptance boundary remain the same but terms
  must change.
- Abandon and bind a new `kei` when the objective or acceptance boundary changes.

Read `keiyaku-bind` for authoring, `keiyaku-akuma` for delegation, and
`keiyaku-babysit` for supervising multiple lanes.
