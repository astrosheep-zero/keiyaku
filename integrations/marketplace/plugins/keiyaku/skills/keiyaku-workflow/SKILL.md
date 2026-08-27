---
name: keiyaku-workflow
description: Use when authoring, binding, auditing, delivering, reviewing, amending, or abandoning a Keiyaku v4 Contract.
---

# Keiyaku Workflow

A Contract turns one bounded delivery into acceptable terms: bind it, work in
the appointed worktree, audit the Contract, deliver, then satisfy its review
gates. Placement claims it when every prerequisite and gate is current.

The lifecycle is `waiting -> bound -> tendered -> claimed | abandoned`;
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

### Managed Worktree Hooks

Configure repository hooks in `<repo>/.keiyaku/settings.json` under the
`worktree` namespace. User defaults live in `~/.keiyaku/settings.json` and may
provide the same entries:

```json
{
  "worktree": {
    "create": [{ "argv": ["npm", "ci"], "timeoutMs": 300000 }],
    "destroy": [{ "argv": ["./scripts/teardown.sh"], "timeoutMs": 60000 }]
  }
}
```

`create` runs when the managed worktree is created; `destroy` runs during
terminal cleanup. `bind` does not print successful hook argv. A failed hook is
reported as `worktree-hook-failed`; retry it explicitly:

```bash
keiyaku reconcile <contract> --retry-hooks
```

The selected commands freeze per worktree and may replay after runner failure,
so keep them replay-safe.

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
<the assignment's high-level intent and goal — not implementation detail,
not a restatement of the Contract terms>
```

Every `Read first` path is relative to `Worktree` unless it is absolute. The
worker starts by reading `.keiyaku/KEIYAKU.md` in that worktree, confirms its
frontmatter names `Contract`, then reads the listed owner documents and source
files before acting. Do not substitute a generic repository tour for the files
that actually govern the assignment.

Contract association, available forwarded actions, and the brief are
independent inputs. Give a Reviewer `--allowed contract.review` only when it
must record its own verdict, and state `--satisfied` or `--unsatisfied` in the
brief. Give a Deliverer `--allowed contract.deliver` when it must tender its
candidate.

A `Deliverer` implements and verifies the terms in `Worktree`. Commission a
`Reviewer` after delivery. The reviewer inspects the complete current Contract
worktree snapshot, not a worker report or named candidate commit, and does not
modify it. Missing or contradictory seat, worktree, or reading list means stop
and ask.

Observe commissioned workers through their Contract association:

```bash
keiyaku wait kei/<contract> --all --timeout 5m
keiyaku wait kei/<first> kei/<second> --any --timeout 5m
```

A Contract selector snapshots its dispatched workers when the command starts.
Use `--all` to wait for every selected worker or `--any` to return when one
finishes; an expanded set with more than one worker requires an explicit mode.

## Decompose Complex Work

Complex Keiyaku should be divided along independently acceptable delivery
boundaries. Use judgment to find those boundaries from the work's objectives,
dependencies, Regions, and acceptance criteria; raw size or file count is not
the test. Give each resulting Contract coherent terms. Connect them with
`--after` only when one must proceed from another's settled result or their
intended work is unsafe to run concurrently.

When a complex Keiyaku cannot be split without breaking one acceptance
boundary, organize its fulfillment into arcs. Do not hand the whole
undifferentiated Contract to one Deliverer and trust one pass to finish it.
Record and work one current chapter at a time.

An arc is a chapter as in a work of literature: one named part of the
delivery's story, not a task list, progress slice, or claim that the work is
mechanically sequential. Its title names the chapter, Objective states that
chapter's aim, and Brief commissions work for that chapter. When an Arc is
active, stay within that current chapter. `.keiyaku/KEIYAKU.md` renders the
current Arc.
Record the next chapter before entering it:

```bash
keiyaku arc <contract> - <<'KEIYAKU'
# <chapter title>

## Objective
<nonblank objective>

## Brief
<nonblank dispatch brief>
KEIYAKU
```

All chapters live inside that Contract's single delivery and acceptance
boundary. The document grammar authority is `docs/document.md`.

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

Audit is an evidence window for a prospective delivery:

```bash
keiyaku audit <contract> --diff
```

Audit is prospective evidence for candidate preparation, Verification, and
target placement. A terminal run may record subject-bound `verified` testimony,
but audit never delivers, requests placement, or satisfies a gate; judge its
facts rather than a worker's completion report.

## Deliver

When the brief assigns delivery to the Deliverer, include `--allowed
contract.deliver`; require it to run the command below after verification and
return the receipt. Otherwise the coordinator runs it after accepting the
candidate.

Deliver when the worktree content is the candidate you intend to land:

```bash
keiyaku deliver <contract> --include-dirty
```

Use `--include-dirty` only when the complete current workspace is the intended
candidate; otherwise commit the intended bytes first. Read the receipt for the
candidate, gate/placement stop, and any physical-effect lag. A not-complete
delivery is still a recorded `tendered` candidate.

`deliver` freshly tenders the candidate and requests placement. A current audit
attestation is reused only when its integration snapshot and Verification
segment still match; changes to the worktree, target, policy, document,
Verification, or snapshot-producing options make it stale.

## Review Gates

A `reviewed` gate wants a recorded judgment of the current patch:

```bash
keiyaku review <contract> --satisfied --summary "<conclusion>"
keiyaku review <contract> --unsatisfied --summary "<finding>"
```

Have an independent reviewer inspect the delivered Contract worktree snapshot.
If it should record the verdict itself, dispatch it with `--allowed
contract.review` and state both verdicts in the brief. Otherwise its answer is
review input for the coordinator to record.
The `review` command records the verdict and `--satisfied` requests placement.

`review --satisfied` is authoritative gate testimony and may claim the Contract
when delivery, prerequisites, and all gates are current. Record it only for the
bytes intended to land now.

Fixing findings changes the patch and makes earlier evidence stale (`?` in
`status`). Audit the rework, deliver it, then review again. Record
`--unsatisfied` only when the negative judgment should remain in Contract
history.

## When Multiple Contracts Overlap On One Target

When active Contracts write a shared surface, landing order is a coordinator
judgment, not Contract state. Keep the decision in the workflow skill; do not
persist a train or add a second placement authority.

- `audit` and a reviewer's report are preliminary; the satisfied review is the
  gate-visible judgment for placement.
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

Managed target checkouts follow Git merge semantics: unrelated staged,
unstaged, and untracked paths are preserved. Staged changes refuse only when
Git cannot carry the predecessor-to-candidate merge; overlapping worktree
changes and colliding untracked files also refuse.

Placement refusal is nonpublishing: the receipt names the reason and paths,
while the target, checkout bytes, candidate, and current review evidence remain
unchanged. Handle the listed paths, then run `deliver` again or record a
satisfied review to request placement again.

## Recover Or End

```bash
keiyaku reconcile <contract>                  # finish accepted lagging effects
keiyaku abandon <contract> --note "<why>"     # terminal; target untouched
```

`reconcile` completes physical effects of already accepted placements; it does
not retry an ordinary placement refusal. Use `--retry-hooks` only for a frozen
failed hook phase. A lagging effect does not change the accepted verdict.
`abandon` ends the Contract and never touches the target.

## Routine Output

Use the complete `kei/...` ID, or `@...` inside a managed worktree. Read a
command's `--help` when its flags or stdin form are unclear.
