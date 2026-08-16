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
the last two are terminal. Reserve `--after` for true logical ordering: one
Contract's result must ultimately build on another's settled outcome, or their
intended work has a large or irreconcilable interaction that should be
sequenced. Ordinary Region overlap is not enough. Small overlaps may proceed
under Git's optimistic write model and be resolved manually or by a delegated
worker. At runtime prerequisites are placement obligations, not a delivery
admission gate: a Contract may record `bound` and deliver before they claim,
while placement waits for the current prerequisites and declared gates. Active
terms may amend `--after` after `bound` or `deliver`; terminal Contracts remain
immutable. You never push it through states by hand: `deliver` and satisfied
reviews request placement, and placement claims when every prerequisite and
gate allows it.

## Bind

Use `keiyaku-bind` to decide readiness, author one bounded Contract, choose
bind inputs, and read the receipt. Continue here from that receipt.

## Work In The Contract Worktree

Change and test code in the worktree the bind receipt names. `deliver` accepts
a clean worktree by default. You may commit first, or explicitly include all
non-ignored staged, unstaged, and untracked final bytes with
`deliver --include-dirty`.

## Regain The Picture

Rebuild state from reads, not memory — after a compact, a handoff, or any
surprising receipt, read before acting:

```bash
keiyaku status                    # the whole board
keiyaku status <contract>         # lifecycle, candidate, one mark per gate
keiyaku show <contract>           # the exact current Contract terms
keiyaku region                    # every active Contract's declared surfaces
keiyaku region <contract>         # one Contract's declared intent
keiyaku region --overlap          # which declared intents intersect
keiyaku region --path <path>      # which active Contracts declare this path
```

`status` marks each gate: `✓` current satisfied, `!` current unsatisfied, `?`
stale because the patch or document changed after the evidence, `○` missing.
A Region is a Contract's declared write intent — not ownership, not a gate,
and not a Git conflict. Read the world before decomposing or commissioning
into an occupied repository; read `--overlap` before choosing a landing order
or an `--after` edge; read `--path` before touching a file that may belong to
another lane. Regions are declarations only, a coarse planning signal: actual
touched paths and conflicts remain Git's.

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
the test. Give each resulting Contract coherent terms. Connect them with
`--after` only when one must proceed from another's settled result or their
intended work is unsafe to run concurrently.

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

Audit is how you see a delivery before it exists:

```bash
keiyaku audit <contract> --show-diff-body
```

Audit is the aggregate Contract view and the exact pre-delivery preview. It
uses the same candidate preparation as deliver, shows the prospective diff and
integration or checkout conflicts, and runs declared Verification against that
candidate. A terminal run records ordinary subject-bound `verified` testimony;
it does not record a delivery or request placement. Read the preview instead of
trusting a worker's completion report.

## Deliver

Deliver when the worktree content is the candidate you intend to land:

```bash
keiyaku deliver <contract>
```

`deliver` freshly tenders the clean `HEAD`, records the candidate, and requests
placement. When a current audit attestation names the identical integration
snapshot and Verification segment, deliver reuses it; otherwise it runs the
declarations. Worktree, target, policy, document, Verification, or
snapshot-producing option changes prevent reuse. If the workspace is dirty, the refusal
lists staged, unstaged, and untracked paths, a short statistic, and the
`--include-dirty` option. Use that option only when the complete current
workspace is the intended delivery; dirty submodule internals cannot be
included. Read the receipt:

- When every gate is current, the receipt shows placement and `claimed`; the
  delivery is done.
- When a gate is not current, the receipt shows the recorded candidate and the
  placement stop. This is not a failed delivery. The Contract stays
  `pending-delivery` while you complete the gates.
- A lag row reports an accepted physical effect that has not finished. The
  delivery stands; `reconcile` completes the effect later. It never changes
  the verdict.

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

## When Multiple Contracts Overlap On One Target

When active Contracts write a shared surface, landing order is a coordinator
judgment, not Contract state. Keep the decision in the workflow skill; do not
persist a train or add a second placement authority.

- `audit` and a reviewer's report are preliminary. `review --satisfied` is
  authoritative gate testimony: it requests placement and claims when
  delivery, prerequisites, and all gates are current. Record it only when the
  reviewed bytes are intended to land now.
- Before recording a satisfied review, or delivering a Contract with no
  declared gates, ask whether the exact patch will survive until placement. A
  pure rebase whose `ChangeId` is unchanged keeps the existing review current;
  do not re-review content addressing kept alive. Conflict resolution that
  changes the `ChangeId` makes earlier testimony stale and requires a fresh
  review against the resolved candidate.
- For Contracts known to overlap, resolve the current-target integration before
  the authoritative review. Preliminary feedback may happen earlier, but it
  is not a satisfied gate until its reviewed patch is the candidate intended
  for placement. Land overlapping Contracts one at a time; let independent,
  non-overlapping Contracts proceed without ceremony. Treat overlap as a
  planning signal, not a correctness verdict.
- After target movement, a changed candidate, or a placement refusal, read the
  current Contract facts again. Recompute the next landing judgment from those
  facts; do not rely on a remembered queue or promise exactly one rebase.

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
