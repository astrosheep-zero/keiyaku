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
- A Debt records confirmed unresolved work and its dependencies.

Use `after` only when one `kei` requires another to be accepted first. Ordinary
overlap is not a dependency.

## 3. Roles

A `kei` has three roles. They are responsibilities, not people, and one agent
may fill more than one of them, with one exception below.

- **Holder:** exactly one per `kei`. Owns the fulfillment loop and acceptance
  until the Contract is accepted or abandoned. Handing work to others never
  transfers this responsibility.
- **Deliverer:** produces the candidate in the appointed worktree and tenders
  it with `deliver`.
- **Reviewer:** judges the complete Contract against its acceptance conditions
  and records the verdict with `review`.

Review is independent when the Reviewer did not deliver the candidate under
review. That is the whole requirement. The holder may review its own `kei`; a
fresh Akuma is not what makes review independent. Keiyaku does not check who
reviews, so keeping the Reviewer apart from the Deliverer is the holder's duty.

Any role may be filled directly or handed to an Akuma. Hand one over when other
hands help the work, not to make review count.

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
  With `verified` selected, Verification runs for the captured subject and can
  record an attestation. Without that gate, the section is inert text and no
  verb runs Verification. A stopped run records no new verdict.
- **Deliver:** Captures a tender and integration against the observed target;
  journal gains a delivered candidate. Ready prerequisites and gates trigger
  placement and claim in this invocation; otherwise the candidate waits.
  Changed candidate content stales earlier review. Identical content retains
  review across rebase or target movement.
- **Review:** Records verdict evidence for the current document and worktree
  content, even before delivery. Satisfied review requests placement: with a
  delivered candidate, current gates, and ready prerequisites, it accepts in
  this invocation. Unsatisfied review records testimony without placement.
- **Abandon:** Records the alternate terminal outcome without accepting. Accepted
  and abandoned Contracts cannot be reopened.

Placement judges declared gates, not the producer's identity. Review does not
replace Verification; audit never requests placement. Read the final receipt
for stops and reconciliation lag after an admitted act.

## 5. Handing A Role To An Akuma

This is the one commissioning map. `call --help` owns the exact action
vocabulary and default set. The flagship acting directly needs no grant.
Birth freezes an Akuma's actions; `--contract` records association, not
authority.

| Role | Grant at birth | Return |
| --- | --- | --- |
| Holder | The actions the delegated loop will perform; include `contract.review` when this holder will review. Commission with the `kei`, current Arc when one exists, appointed worktree, and holder duties. | Acceptance or abandonment, with receipts. |
| Deliverer | The ordinary baseline: every Debt mutation, Contract audit and delivery, and Akuma management. `keiyaku -C <repo> call worker --alias @deliverer --contract <kei/...> --workdir <appointed-path> -` | The delivery receipt. |
| Reviewer | `--allowed contract.review`: `keiyaku -C <repo> call review-akuma --alias @reviewer --contract <kei/...> --workdir <appointed-path> --allowed contract.review -` | The verdict receipt. Without the grant, `not-allowed` refuses and no verdict is recorded. |

An Archetype's explicit allowed set replaces the ordinary baseline; check
`status` for effective actions. `tell` and `fork` cannot add a grant to a live
Akuma, so call a fresh one with the grant. Nested calls cannot exceed their
direct parent's actions.

Commission with a clear objective, current Arc when one exists, appointed
worktree, and expected result. Never ask the Akuma that delivered a candidate
to review it. Use `keiyaku-akuma` for invocation and observation, and command
help for exact syntax.

## 6. Decide What Happens Next

The holder checks candidate, verification, review, prerequisites, and gates.

- A ready delivered candidate claims automatically on delivery or satisfied
  review; no separate claim command is needed.
- Missing evidence or unfinished work calls for another commission or chapter.
- Amend when the objective and acceptance boundary remain the same but terms
  must change.
- Abandon and bind a new `kei` when the objective or acceptance boundary changes.

Read `keiyaku-bind` for authoring, `keiyaku-akuma` for delegation, and
`keiyaku-babysit` for supervising multiple lanes.
