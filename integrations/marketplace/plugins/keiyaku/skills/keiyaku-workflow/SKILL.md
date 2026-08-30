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

## Choose The Lightest Sufficient Workflow

Do not put every small change through the full Contract lifecycle.

- Implement directly when the scope is small, understood, and easy to verify.
- Bind a Contract without a review gate when the work is larger but mechanical,
  and a bounded worktree or delivery record is useful. Add review when judgment,
  risk, or independent acceptance makes it valuable.
- If direct work grows beyond its original scope, stop and bind a Contract then.
  Capture only the task-owned changes in a commit, cherry-pick that commit into
  the appointed worktree, and continue there. Preserve unrelated caller changes.

Choose by uncertainty, risk, and coordination cost, not file count. Public or
persisted semantics, resource ownership, concurrency, security, and disputed
architecture usually justify full terms and independent review. A narrow
wording correction or exact mechanical synchronization usually does not.

## Bind

Use `keiyaku-bind` to decide readiness, author one bounded Contract, choose
bind inputs, and read the receipt. Continue here from that receipt.

Managed worktree hooks are transient named command arrays. Each command has a
nonblank `name`, `argv`, and `timeoutMs`; create and destroy arrays execute
serially in the current caller. There is no durable marker, frozen command
snapshot, detached runner, or per-command retry index. `--retry-hooks` reruns
the complete current phase, so hook authors own idempotence. A successful bind
receipt prints create hook names in order under `hooks create` and never prints
their argv or timeout.

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

## Hold the Fulfillment Loop

Every Contract in flight has exactly one holder of its fulfillment
loop: whoever is currently turning intent into commissions and
returns into decisions. By default that is the flagship caller.
Holding the loop means:

- **Decompose before delegating.** Cut the work along its real
  acceptance boundaries — separate Contracts where they exist, Arcs
  where they do not, Tasks for what is planned but not yet owed —
  before any commission goes out. Delegation spends a decision that
  has already been made; it is not where the decision happens.
- **Requirements in a tell carry provenance.** A decision that
  appears in a commission or tell as a requirement must come from
  user intent, the journaled terms, or standing authority. A
  hypothesis formed mid-loop is not yet any of those: send it down
  as a question to investigate, or settle it first — a real
  decision, a journaled amend — and only then require it.
- **Returns are inputs to judgment, not the next instruction.**
  What a worker or reviewer sends back is consumed by the holder,
  who decides what it is and what happens — see the review section
  below.
- **Keep the work converging on the Objective.** The Objective is
  the direction of the loop. When successive rounds move the
  candidate away from what the Contract set out to make true, the
  loop is telling you the premise needs judgment, not that another
  round is owed.

The whole loop can be handed to one Aku in a single commission. The
duties above travel with it — the delegate holds them exactly as
the flagship would, deciding for itself when to cut Arcs and Tasks
and when to call, tell, and review. It needs no title and no new
identity beyond the commission itself. After handing over, the
flagship steers through the holder — a tell to the holder, a
journaled amend, escalation, or withdrawing the commission — and
does not reach past it to steer its subordinates directly.

None of this is a required ceremony. Small work is done directly;
Tasks and Arcs appear when the work calls for them. The loop adds
no cadence, no threshold, no identity, no state, and nothing the
tool core enforces — it is how the holder thinks, not a stage the
work passes through.

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

The bind skill's authority order makes a commissioning brief zero-authority.
Use it only to focus attention within the current Contract or Arc, point to
evidence, and ask questions. It must not add or change acceptance terms, prescribe an
unsettled implementation mechanism or expected review finding, or ask a
reviewer to re-prove an earlier judgment. Removing the brief must not change
the candidate's acceptance basis. Change terms through a journaled `amend`,
not through `call` or `tell`.

Contract association, available forwarded actions, and the brief are
independent inputs. Give a Reviewer `--allowed contract.review` only when it
must record its own verdict, and require it to choose `--satisfied` or
`--unsatisfied` from its independent judgment. Give a Deliverer `--allowed
contract.deliver` when it must tender its candidate.

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
Handing over a whole Contract is legitimate in exactly one form: as
a transfer of its fulfillment loop, not as one oversized Deliverer
assignment. Commission one Aku to hold the loop and let it decide
when to cut Arcs and Tasks and when to call, tell, and review. A
Deliverer owes a candidate; a loop holder owes decisions.
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

Have a reviewer independent from the Deliverer and candidate implementation
inspect the delivered Contract worktree snapshot. Start a new Contract with a
new `call --contract`; do not repurpose another Contract's reviewer with
`tell`. Reuse that reviewer identity by default for later rounds of the same
Contract. Start a replacement with a recorded reason when the reviewer's
judgment frame is contaminated or the reviewer is involved in the term defect.
If it should record the verdict itself, dispatch it with `--allowed
contract.review` and require it to choose the verdict from its independent
judgment. Otherwise its answer is review input for the coordinator to record.
The `review` command records the verdict and `--satisfied` requests placement.

A repeat review re-judges the complete current snapshot from repository
authority; checking whether an earlier finding closed is only one part of that
judgment. If the same root cause produces a second unsatisfied review, stop
commissioning stronger remediation for the candidate. Amend the Criterion from
named authority or a constructible current failure, remove it, or escalate the
unresolved premise. A conflicting, undefined, or ungrounded term is reported
without a review receipt until `amend` makes the Contract adjudicable.

`review --satisfied` is authoritative gate testimony and may claim the Contract
when delivery, prerequisites, and all gates are current. Record it only for the
bytes intended to land now.

A review return is input to the loop holder's judgment, never a
work order in itself. Classify before anything moves: a current
defect against the terms is fixed and re-reviewed; advice worth
keeping but not owed becomes a Task or is consciously declined; a
problem with the terms or the premise goes up — journaled amend or
escalation — before any remediation is commissioned; work outside
the Contract stays outside it. The test for every response is the
Objective: remediation that drifts the candidate away from what
the Contract set out to make true is evidence against the premise,
not a reason for another round.

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
  review: re-inspect the resolved candidate and record new testimony. Fresh
  review follows the reviewer-reuse rule above; prefer the existing independent
  reviewer when its judgment frame remains sound, especially so earlier findings
  can be checked within the complete fresh judgment.
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
