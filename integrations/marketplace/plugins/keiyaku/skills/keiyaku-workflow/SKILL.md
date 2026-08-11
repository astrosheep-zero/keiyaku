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

### Decide The Threshold

Bind when the document describes a decision, not an investigation: one
objective, a clear delivery boundary, and Criteria decidable at acceptance
without inventing taste. If a plausible unresolved fact could change the
Objective, Design, or acceptance boundary, investigate first and bind after.

### Write The Document

Write one Markdown document with an H1 title, the sections `Context`,
`Objective`, `Design`, a fenced `Region`, and H3 entries under `Criteria`.
`Verification` is optional and holds the executable check that `deliver` will
run.

~~~markdown
# <name this delivery>

## Context
<established facts that frame the decision>

## Objective
<one observable delivery outcome>

## Design
<ownership, boundaries, and constraints a test-green candidate could still violate>

## Region
```
<expected write surface>
```

## Criteria
### <criterion title>
<one decidable acceptance condition>

## Verification
```bash
<executable check>
```
~~~

### Bind It

```bash
keiyaku bind -                       # managed worktree, default target and gates
keiyaku bind --task <task/...> -     # associate an existing Task
keiyaku bind --target <ref> -        # choose the placement ref
keiyaku bind --here -                # work in the current worktree instead
keiyaku bind --after <kei/...> -     # wait for prerequisite Contracts
keiyaku bind --gates <name> -        # select a configured gate set
```

The receipt is your next state: it prints the complete Contract ID, the managed
worktree path, and the target facts. Work from the receipt, not from memory.
Omitting `--gates` selects the configured `gates.default`, or no gates when
that entry is absent. `--task` ties the Task to this Contract: `claimed` marks
the current held Task done, while `abandon` releases it.

## Work In The Contract Worktree

Change and test code in the worktree the bind receipt names. You do not need
to commit: `deliver` captures dirty and untracked bytes as they stand. Check
where you are at any point:

```bash
keiyaku status [<contract>|@<contract>]
```

`status` shows the lifecycle state, the candidate, and one mark per gate: `✓`
current satisfied, `!` current unsatisfied, `?` stale because the patch or
document changed after the evidence, and `○` missing.

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

`deliver` tenders the current worktree bytes as the candidate, runs the
declared `Verification`, records the candidate, and requests placement. Read
the receipt:

- When every gate is current, the receipt shows placement and `claimed`; the
  delivery is done.
- When a gate is not current, the receipt shows the recorded candidate and the
  placement stop. This is not a failed delivery. The Contract stays
  `pending-delivery` while you complete the gates.

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

Fixing findings changes the patch, which turns earlier evidence stale (`?` in
`status`): review the current patch again. Record `--unsatisfied` only when the
negative judgment should remain in Contract history.

## Target Placement

Placement follows the Git mental model you already have:

- Delivering from a managed worktree to a checked-out target behaves like a
  merge. Non-overlapping unstaged and untracked files in that checkout are
  preserved. Overlapping changes, colliding untracked files, or any staged
  changes refuse placement with the exact paths. The deliver or review you
  just ran still counts: the recorded candidate and any `✓ reviewed` verdict
  are kept, but nothing claims and nothing moves. The target ref, its checkout,
  and your bytes stay exactly where they were, and the Contract stays
  `pending-delivery`.
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

`audit` shows the current document, candidate diff, verification, and gates
without changing anything. `reconcile` completes physical effects of already
accepted placements; it does not retry an ordinary placement refusal.
`abandon` ends the Contract and never touches the target.

## Routine Output

Use default text output for normal operation and `--json` only when a script
needs the public result. Use the complete `kei/...` ID, or `@...` inside a
managed worktree. When a flag or stdin form is unclear, read that command's
`--help` instead of guessing.
