---
name: keiyaku-workflow
description: Hold a Contract's fulfillment loop — the loop-holder's five decisions across the whole active loop, from a waiting or bound Contract to claimed or abandoned. Hold or delegate; shape the work into Contracts, Arcs, and Tasks; commission Deliverer and Reviewer seats; adjudicate deliver, review, and audit returns, amend or abandon; schedule landing. For the flagship or the single delegate holding a whole loop.
---

# Holding a fulfillment loop

You are the loop-holder: the one reader of this skill. Flagship and
whole-loop delegate are the same reader — same decisions, same tools,
no special role or permission either way.

The state you steer: a Contract moves `waiting -> bound -> tendered ->
claimed | abandoned`; claimed and abandoned are terminal. Prerequisites
and declared gates block placement, never delivery admission. Deliver
and a satisfied review each request placement; placement claims only
when every current obligation permits.

Routing. Authoring a Contract — its boundary, terms, gates — is
keiyaku-bind. Commission, call, tell, wait, permission, and history
mechanics are keiyaku-akuma. Attention across many waiting lanes is
keiyaku-babysit. Seat procedure travels with the worktree: the
generated seat skill in each appointment tells the Deliverer and
Reviewer what to do. Exact grammar for any command is that command's
help, nowhere else.

## Decision 1 — hold or delegate

Take the lightest shape that carries the work. Direct work may skip a
Contract entirely. Bounded mechanical work may take a Contract with no
review gate. Tasks and Arcs are optional planning, never ceremony owed
to the tool.

The shape is not fixed at the start. Work begun directly that grows
beyond expectation escalates midstream: bind a Contract then, and
carry the change you already have into the appointed worktree as the
candidate-in-progress. Nothing is lost by starting light; the only
mistake is continuing an oversized effort outside any acceptance
boundary because it happened to start there.

Hold the loop yourself when you will decompose or implement. Delegate
the whole loop when you steer at direction level: one commission hands
one Aku the entire loop. Delegation changes who decides, not what
exists — it creates no role, state, or journal fact. A whole-loop
commission uses Contract association plus an explicit repository
working directory; the automatic Contract-worktree working directory
is for seat commissions only. Once delegated, steer through the
holder, never around it. The delegate owes decisions and coordination,
and may open Tasks, Arcs, and seat commissions beneath itself.

## Decision 2 — shape the work

Cut by what must be independently acceptable. Multiple independently
acceptable outcomes are separate Contracts. One acceptance boundary
whose work still has chapters may use Arcs — chapters inside a single
acceptance, never separately placeable. Decomposition and dependency
memory that must outlive a conversation is a Task. The failure this
decision prevents: an oversized boundary handed to one Deliverer as a
single ordinary assignment, with no chapters and no durable plan.

Authoring the Contract itself belongs to keiyaku-bind. A landing
dependency — this Contract's placement genuinely requires that one
landed — is a real `after` relation. Ordinary overlap is not: Regions
are planning evidence for your scheduling eye, never ownership and
never a gate.

## Decision 3 — commission seats

A commission names one Contract, one seat, one worktree, and the
capabilities that seat needs. A Deliverer owes a candidate; a Reviewer
owes independent testimony. Grant only the actions required by that
duty and verify them at dispatch. A self-recording Reviewer needs
`contract.review` and therefore cannot be `--readonly`; use that flag
only when another actor records the verdict. The configuration grammar
is keiyaku-akuma's and the command's help.

The prompt conveys the rest, in words this literal:

    Contract: <contract>
    Seat: Deliverer (or Reviewer)
    Worktree: <exact path>
    Read first:
    - .keiyaku/KEIYAKU.md
    - <exact governing owner-law paths>
    - <exact relevant source paths>
    This round: <one-sentence objective>

A commission directs the round; it cannot amend acceptance. Standing
acceptance is only the journaled terms and their amendments.

Reviewer reuse is the default within one Contract while the judgment
frame stays sound; a new Contract gets a new Reviewer.

## Decision 4 — adjudicate returns

Review is two-valued: satisfied or unsatisfied, testified over the
complete current candidate or document subject. Satisfied requests
placement and may be the invocation that claims; unsatisfied never
places. When satisfied cannot be reached, the summary names what
blocks it: the candidate, the required evidence, or the terms as
written. Advice beyond acceptance may accompany testimony and changes
no verdict. A returned Reviewer verdict is transported faithfully into
testimony, or a fresh independent review is commissioned — never
paraphrased into a different verdict. A Contract with no review gate
neither requires nor owes any review.

Deliver records the intended candidate, freshly prepares it against
the target as the target exists for that invocation, runs or reuses
Verification, and requests placement. A clean worktree delivers its
HEAD; a dirty delivery captures the complete non-ignored state as an
immutable commit without moving the branch or the real index — a
prior git commit is optional shaping, never a prerequisite. Deliver
never satisfies a review gate.

Audit observes: prospective candidate, integration, Verification,
diff, target. It records no candidate and satisfies no gate.

Evidence goes stale by subject identity: a changed candidate or
amended terms stales the testimony over that subject. Amend only
while the same objective and acceptance boundary remain truthful —
amendment reshapes terms inside the same promise. When the objective
or the boundary itself has changed, abandon and bind a truthful new
Contract; do not steer old terms onto a different delivery. Abandon
ends a Contract without moving the target.

## Decision 5 — schedule landing

You schedule overlapping Contracts; nothing persists an ordering — no
train exists in the tool. When the target has moved, prepare the
current-target integration before the authoritative review. A
content-equivalent preparation retains standing testimony; a changed
conflict resolution stales it. Target movement requires fresh deliver
or audit preparation.

A placement refusal preserves the candidate and the testimony and
leaves target and checkout untouched: resolve the blocking obligation
and request placement again. Reconcile finishes accepted lagging
effects; it does not retry a placement refusal. Rebuild your picture
at any time from the read surfaces — status, show, region — whose
grammar lives in their help.
