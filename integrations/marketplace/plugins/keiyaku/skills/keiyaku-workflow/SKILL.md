---
name: keiyaku-workflow
description: Use when authoring, binding, auditing, delivering, reviewing, amending, or abandoning a Keiyaku v4 Contract.
---

# Keiyaku Workflow

A Contract turns one bounded delivery into acceptable terms: bind it, work in
the appointed worktree, audit the Contract, deliver, then review. When every
declared gate is current, the result lands on the target ref.

## How The Delivery Moves

```text
contract document -> bind -> work -> audit -> deliver -> review gates
                                                    -> placement -> claimed
                                                                \-> abandoned
```

The lifecycle is `waiting -> bound -> pending-delivery -> claimed | abandoned`;
the last two are terminal. `--after` prerequisites are placement obligations,
not a delivery admission gate: a Contract may record `bound` and deliver before
they claim, while placement waits for the current prerequisites and declared
gates. Active terms may amend `--after` after `bound` or `deliver`; terminal
Contracts remain immutable. You never push it through states by hand: `deliver`
and satisfied reviews request placement, and placement claims when every
placement obligation allows it.

## Bind

Use `keiyaku-bind` to decide readiness, author one bounded Contract, choose
bind inputs, and read the receipt. Continue here from that receipt.

## Work In The Contract Worktree

Change and test code in the worktree the bind receipt names. `deliver` accepts
a clean worktree by default. You may commit first, or explicitly include all
non-ignored staged, unstaged, and untracked final bytes with
`deliver --include-dirty`. Check where you are at any point:

```bash
keiyaku status [<contract>|@<contract>]
```

`status` shows the lifecycle state, the candidate, and one mark per gate: `✓`
current satisfied, `!` current unsatisfied, `?` stale because the patch or
document changed after the evidence, and `○` missing.

## Commission A Contract

When another agent will fulfill or review the Contract, the commissioning
harness must pass one explicit seat and one exact worktree. `--contract` or an
equivalent association identifies the Contract; it does not appoint a seat.
Never ask the worker to infer either value.

Use this minimum handoff in the dispatch body, regardless of harness:

```text
Contract: kei/...
Seat: Deliverer | Reviewer
Worktree: /absolute/path/from-the-bind-receipt
Read first:
- .keiyaku/KEIYAKU.md
- <owner documents governing this delivery>
- <source files named or selected from the Contract Region for this work>
Objective:
<bounded assignment>
```

Every `Read first` path is relative to `Worktree` unless it is absolute. The
worker starts by reading `.keiyaku/KEIYAKU.md` in that worktree, confirms its
frontmatter names `Contract`, then reads the listed owner documents and source
files before acting. Do not substitute a generic repository tour for the files
that actually govern the assignment.

A `Deliverer` implements and verifies the terms in `Worktree`. Commission a
`Reviewer` after delivery. The reviewer inspects the complete current Contract
worktree snapshot, not a worker report or named candidate commit, and does not
modify it. Missing or contradictory seat, worktree, or reading list means stop
and ask.

## Decompose Complex Work

Complex Keiyaku should be divided along independently acceptable delivery
boundaries. Use judgment to find those boundaries from the work's objectives,
dependencies, Regions, and acceptance criteria; raw size or file count is not
the test. Give each resulting Contract coherent terms, and connect ordering
with `--after` where needed.

When one acceptance boundary still spans several coherent implementation
chapters, record each chapter as an arc before moving to the next:

```bash
keiyaku arc <contract> -
```

The stdin body is the arc's Markdown; see `arc --help` for its shape. Arcs
narrate progress inside that Contract's single delivery and acceptance
boundary.

## Amend Or Start Over

Use `amend` when a discovery during the same delivery changes terms but the
original Objective, Design, and acceptance boundary still truthfully describe
the result:

```bash
keiyaku amend <contract> -
```

See `amend --help` for the operation grammar. If the objective or boundary
itself changed, `abandon` with a note and bind a new Contract; do not steer an
old Contract onto a different delivery.

## Audit Before Delivery

Audit before each delivery or redelivery:

```bash
keiyaku audit <contract> --show-diff-body
```

Audit is the aggregate Contract view: delivery history, Verification testimony,
gate evidence, target drift, and rework/review timeline. With an existing
candidate it also shows its diff and reruns declared Verification. Before the
first delivery there is no candidate to diff or verify. Audit never requests
placement. Read it instead of trusting a worker's completion report.

## Deliver

Deliver after audit and before review:

```bash
keiyaku deliver <contract>
```

`deliver` tenders the clean `HEAD`, runs the declared `Verification`, records
the candidate, and requests placement. If the workspace is dirty, the refusal
lists staged, unstaged, and untracked paths, a short statistic, and the
`--include-dirty` option. Use that option only when the complete current
workspace is the intended delivery; dirty submodule internals cannot be
included. Read the receipt:

- When every gate is current, the receipt shows placement and `claimed`; the
  delivery is done.
- When a gate is not current, the receipt shows the recorded candidate and the
  placement stop. This is not a failed delivery. The Contract stays
  `pending-delivery` while you complete the gates.

Verification declarations may set an individual timeout in the fence info
string, using an explicit duration unit such as `bash timeout=5m`. Omit the
attribute for an unbounded declaration; there is no Verification-wide timeout.

## Review Gates

A `reviewed` gate wants a recorded judgment of the current patch:

```bash
keiyaku review <contract> --satisfied --summary "<conclusion>"
keiyaku review <contract> --unsatisfied --summary "<finding>"
```

Have an independent reviewer inspect the delivered Contract worktree snapshot.
The `review` command records the verdict. `--satisfied` requests placement; if
the other gates are current, the receipt shows `claimed`.

Fixing findings changes the patch and makes earlier evidence stale (`?` in
`status`). Audit the rework, deliver it, then review again. Record
`--unsatisfied` only when the negative judgment should remain in Contract
history.

## Target Placement

Placement follows the Git mental model you already have:

- Delivering from a managed worktree to a checked-out target behaves like a
  merge. Non-overlapping staged, unstaged, and untracked files in that checkout
  are preserved. A staged path refuses only when Git cannot carry it through
  the predecessor-to-candidate merge; overlapping worktree changes and
  colliding untracked files also refuse. The receipt lists the exact paths.
  The deliver or review you just ran still counts: the recorded candidate and
  any `✓ reviewed` verdict are kept, but nothing claims and nothing moves.
  The target ref, its checkout, and your bytes stay exactly where they were,
  and the Contract stays `pending-delivery`.
- A `--here` Contract behaves like a commit with gates: it lands on the current
  branch and cannot deliver to a foreign checked-out target.

After a refusal, handle the listed paths, then `deliver` again or record a
satisfied review; either command requests placement again.

## Recover Or End

```bash
keiyaku reconcile <contract>                  # finish accepted lagging effects
keiyaku abandon <contract> --note "<why>"     # terminal; target untouched
```

`reconcile` completes physical effects of already accepted placements; it does
not retry an ordinary placement refusal. `abandon` ends the Contract and never
touches the target.

## Routine Output

Use default text output for normal operation and `--json` only when a script
needs the public result. Use the complete `kei/...` ID, or `@...` inside a
managed worktree. When a flag or stdin form is unclear, read that command's
`--help` instead of guessing.
