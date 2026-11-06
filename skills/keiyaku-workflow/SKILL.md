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

This section teaches operation semantics across interfaces; get exact invocation grammar from CLI leaf help or the corresponding exposed tool description.

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
  evidence remains unmet; preview never promises acceptance.
- **Verify:** Only explicit `verify` executes declarations, and it requires the
  `verified` gate; an unselected Verification section is inert. `verify` executes
  all current declarations, or one selected by `--index <n>` using its positive
  one-based position. `--include-dirty` authorizes dirty capture. It captures the appointed worktree under
  delivery's clean-worktree and dirty authorization rules and prepares the exact
  prospective integration without delivering it. Conflicts refuse without a
  handoff. Each check has independent scratch, setup, cleanup, and requirement
  testimony. Verify runs with the invoking process's native Git and process
  custody. Each terminal check admits its testimony before later checks begin.
  Normal failure or timeout records unsatisfied testimony for that requirement
  and does not stop other selected checks. Operational stops may stop
  later checks and admit no testimony for the affected check, while preserving
  earlier admissions; a verdict reached before an admission stop remains a verdict,
  not recorded testimony. Verify always executes its selection, even if identical
  testimony can reuse admission. It then requests ordinary placement of an
  already-delivered Contract when every prerequisite and gate passes;
  pre-delivery verify records evidence without placement.
- **Deliver:** Captures a tender and integration against the observed target;
  journal gains a delivered candidate. It never executes Verification. Ready
  prerequisites and existing gate evidence trigger placement and claim in this
  invocation; otherwise the candidate waits.
  Changed candidate content stales earlier review. Identical content retains
  review across rebase or target movement.
- **Review:** Records verdict evidence for the current document and worktree
  content, even before delivery. Satisfied review requests placement: with a
  delivered candidate, current gates, and ready prerequisites, it accepts in
  this invocation. Unsatisfied review records testimony without placement.
  Neither verdict executes Verification.
- **Abandon:** Records the alternate terminal outcome without accepting. Accepted
  and abandoned Contracts cannot be reopened.

Placement judges declared gates, not the producer's identity. Every current
requirement needs current satisfied testimony; missing, stale, and current
unsatisfied evidence remain distinct. Whole-gate satisfaction follows the generic
judgment over all requirements. Verification requirement identity follows
canonical executor, script, and declared deadline; declaration position only
selects work. Reordering preserves evidence,
editing one check affects only that requirement, and exact duplicates share a
requirement. Removed declarations leave historical testimony intact.

Deliver, review, target refresh, and dependent completion consume existing
evidence only. Review does not replace Verification; preview never requests
placement. Verify evidence applies to its exact captured integration snapshot:
an unchanged later delivery can use pre-delivery evidence, while target or
candidate movement cannot retarget it. Read the final receipt for every executed
check, admission or admission reuse, stops, retained scenes, completion, and
reconciliation lag.

## 4. Handing A Role To An Akuma

This is the one commissioning map. `--contract` records association, not
authority.

| Role | Commission | Return |
| --- | --- | --- |
| Holder | Commission the `kei`, current Arc when one exists, appointed worktree, and holder duties. | Acceptance or abandonment, with receipts. |
| Deliverer | Commission the objective, including explicit Verification when needed: `keiyaku -C <repo> call worker --alias @deliverer --contract <kei/...> --workdir <appointed-path> -` | Requested verify results and delivery receipt. |
| Reviewer | `keiyaku -C <repo> call review-akuma --alias @reviewer --contract <kei/...> --workdir <appointed-path> -` | The verdict receipt. |

Commission with a clear objective, current Arc when one exists, appointed
worktree, and expected result. Never ask the Akuma that delivered a candidate
to review it. Use `keiyaku-akuma` for invocation and observation, and command
help for exact syntax.

## 5. Decide What Happens Next

The holder checks candidate, verification, review, prerequisites, and gates.

- A ready delivered candidate claims on delivery, satisfied review, or explicit
  verify after its selected work; no separate claim command is needed.
- Missing evidence or unfinished work calls for another commission or chapter.
- Amend when the objective and acceptance boundary remain the same but terms
  must change.
- Abandon and bind a new `kei` when the objective or acceptance boundary changes.

Read `keiyaku-bind` for authoring, `keiyaku-akuma` for delegation, and
`keiyaku-babysit` for supervising multiple lanes.
