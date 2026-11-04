---
name: keiyaku-workflow
description: >-
  Read when holding a `kei`: its roles, lifecycle, handing roles to Akumas,
  and deciding to accept, amend, or abandon.
---

# Keiyaku Workflow

The holder runs one Contract's fulfillment loop from preparation to completion.

## 1. Before Binding

Shape and author the `kei` with `keiyaku-bind`. Do not bind while design or
acceptance is open; only private implementation details may stay with the
Deliverer.

## 2. Roles

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

## 3. Lifecycle

Each act changes a different part of the world:

- **Bind:** Journal gains the Contract and its terms. Workspace appointment
  names one managed worktree; the receipt reports its path. Appointment lag
  leaves the bind admitted without a path and reports pending reconciliation.
  `reconcile` retries workspace realization.
- **Work:** Changes and commits belong in the appointed worktree. Another
  lane's claim can move the target beneath it. Check target movement before
  delivery preview; when needed, merge the selected target's committed head in
  the worktree and resolve conflicts there before previewing again. A Contract
  target is its appointed detached worktree, not its ordinary branch.
- **Delivery preview:** `deliver --dry-run` shows the candidate, existing
  Verification evidence, and target followability without submitting work or
  running Verification or hooks. With the `verified` gate, missing or stale
  evidence still needs Verification; preview never promises acceptance.
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
replace Verification; delivery preview never requests placement. Read the final receipt
for stops and reconciliation lag after an admitted act.

## 4. Handing A Role To An Akuma

This is the one commissioning map. `--contract` records association, not
authority.

| Role | Commission | Return |
| --- | --- | --- |
| Holder | Commission the `kei`, current Arc when one exists, appointed worktree, and holder duties. | Acceptance or abandonment, with receipts. |
| Deliverer | `keiyaku -C <repo> call worker --alias @deliverer --contract <kei/...> --workdir <appointed-path> -` | The delivery receipt. |
| Reviewer | `keiyaku -C <repo> call review-akuma --alias @reviewer --contract <kei/...> --workdir <appointed-path> -` | The verdict receipt. |

Commission with a clear objective, current Arc when one exists, appointed
worktree, and expected result. Never ask the Akuma that delivered a candidate
to review it. Use `keiyaku-akuma` for invocation and observation, and command
help for exact syntax.

## 5. Decide What Happens Next

The holder checks candidate, verification, review, prerequisites, and gates.

- A ready delivered candidate claims automatically on delivery or satisfied
  review; no separate claim command is needed.
- Missing evidence or unfinished work calls for another commission or chapter.
- Amend when the objective and acceptance boundary remain the same but terms
  must change.
- Abandon and bind a new `kei` when the objective or acceptance boundary changes.

Read `keiyaku-bind` for authoring, `keiyaku-akuma` for delegation, and
`keiyaku-babysit` for supervising multiple lanes.
