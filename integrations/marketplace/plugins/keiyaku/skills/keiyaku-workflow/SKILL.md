---
name: keiyaku-workflow
description: Use when authoring, binding, delivering, reviewing, amending, auditing, or abandoning a Keiyaku v4 Contract.
---

# Keiyaku Workflow

A Contract turns one bounded delivery into acceptable terms: write what done
means, bind it, work in the worktree the receipt names, and deliver. When
every declared gate is current, the result lands on the target ref. This is
the whole trip from current work to `claimed`.

## How The Delivery Moves

```text
contract document -> bind -> work in the Contract worktree -> deliver
                             -> review gates -> placement -> claimed
                                                      \-> abandoned
```

The lifecycle is `waiting -> bound -> pending-delivery -> claimed | abandoned`;
the last two are terminal. `--after` prerequisites hold a Contract at
`waiting`; it becomes `bound` automatically once they are satisfied. You never
push it through states by hand: `deliver` and satisfied reviews request
placement, and placement claims when the gates allow it.

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

A `Deliverer` implements and verifies the terms, keeps all work in `Worktree`,
and reports the candidate, checks run, and unmet terms. A `Reviewer` reads the
same worktree and Contract, judges the current candidate with direct evidence,
and does not modify it. If `Seat`, `Worktree`, or the required reading list is
missing or contradictory, the worker stops and asks the caller instead of
guessing.

## Arcs For Large Deliveries

When one Contract carries several coherent chunks, record each chunk as an arc
before moving to the next:

```bash
keiyaku arc <contract> -
```

The stdin body is the arc's Markdown; see `arc --help` for its shape. Arcs
narrate one delivery; they do not split acceptance. Work that needs its own
independent acceptance is a new Contract, not an arc.

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

## Deliver

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

Have an independent reviewer read the exact Contract worktree first; the
`review` command records the gate-visible verdict. `--satisfied` requests
placement. If the same patch is already delivered and the other gates are
current, the receipt shows `claimed`. Review works before or after deliver.
When the reviewed projection includes ordinary dirty workspace bytes, the
review receipt discloses those paths and stats; delivery still needs
`deliver --include-dirty` before those bytes become the candidate.

Fixing findings changes the patch, which turns earlier evidence stale (`?` in
`status`): review the current patch again. Record `--unsatisfied` only when the
negative judgment should remain in Contract history.

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

## Observe, Recover, Or End

```bash
keiyaku audit <contract> [--show-diff-body]   # report only; never places
keiyaku reconcile <contract>                  # finish accepted lagging effects
keiyaku abandon <contract> --note "<why>"     # terminal; target untouched
```

`audit` is one aggregate read of the document, candidate diff, Verification,
gates, and target status. `reconcile` completes physical effects of already
accepted placements; it does not retry an ordinary placement refusal.
`abandon` ends the Contract and never touches the target.

## Routine Output

Use default text output for normal operation and `--json` only when a script
needs the public result. Use the complete `kei/...` ID, or `@...` inside a
managed worktree. When a flag or stdin form is unclear, read that command's
`--help` instead of guessing.
