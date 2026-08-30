# Git Reconciliation

This chapter owns replayable Git topology effects, managed-worktree hooks, and
their transparent effects and lags. It repairs desired physical custody from
accepted facts and fresh external observation. Reconciliation is idempotent
across retries and process restarts, writes no journal fact, and cannot reverse
admission. It is the sole repair primitive for accepted-but-lagged Git effects.

## Replay And Concurrency

Each Contract effect decision is serialized independently. It reads current
Contract authority and current topology under that Contract's custody boundary,
then applies the effects that remain necessary. Ordinary admission does not use
this boundary; target placement uses the separate target fence from [git.md](git.md).
Different Contracts need no shared effect lock. A mutation that admitted newer
authority triggers reconciliation from that newer state, so a prior replay
cannot establish a competing terminal physical meaning.

Reconciliation reports what it observed and completed, plus typed lags for work
it could not safely complete. It does not claim the outcome of an unreported
effect. Authority corruption remains an exception. A lag is safe to retry:
every replay begins from durable facts and fresh topology, never a process-local
receipt, progress marker, frozen hook list, detached runner, or recovery queue.
Confirmed reset is a separate Git-owned operation, not reconciliation.

## Worktrees, Placement Recovery, And Custody

For an active Contract, reconciliation repairs necessary custody and realizes
or retains its appointed managed worktree. It never overwrites an existing
worktree merely to make it match a delivery. Dependency continuation may
advance only a clean, compatible dependent worktree. These physical repairs
create no candidate, review, target movement, or journal fact.

Reconciliation observes a materialized handoff through Git's private receipt
and the receipt's recorded live identity, not through topology or equal bytes.
It can discard an orphan receipt only when no live operation remains. After
delivery admission, it retires a fully matching handoff's merge metadata
without touching the real index or worktree; failure remains recoverable lag
and never revokes delivery. Terminal reconciliation performs the same
retirement before it removes a worktree. Mismatched, incomplete, or unrelated
state is retained unchanged. The same proof permits explicit rematerialization
to retire a prior handoff; neither conflict resolution completeness nor tree
equality is an ownership test.

Target-checkout recovery can complete only the current claimed
predecessor-to-candidate movement while the checkout state proves it can carry
that movement. It never adopts an older ancestor, retries a pre-publication
refusal, recaptures a candidate, or overwrites incompatible concurrent state.
A successful recovery is an observed physical effect; incompatible state is
retained unchanged.

Pending delivery keeps the required tender and integration custody. Terminal
cleanup applies Git's sealed-byte and surviving-custodian law from
[git.md](git.md); reconciliation owns only the fresh topology observation and
physical replay. A worktree is removed before its appointment or redundant refs
are released. Retention is a lag, not a changed acceptance result.

## Hooks And Scratch

Managed-worktree create and destroy hooks are physical effects, not Contract
lifecycle facts, settlement, or a general event system. Git receives opaque
commands from the library and runs an ordered phase in the managed worktree.
Hook authors must make a complete phase replay-safe: a retry reruns the current
phase from its beginning. A hook failure retains the worktree and required
custody, reports a lag, and cannot abandon or reverse the Contract. Hooks cannot
reenter mutation or reconciliation for the same Contract while that effect
decision owns its custody boundary.

Verification scratch has a separate disposable lifecycle. It is never a
managed-worktree replay, does not gain markers or resumable command state, and
is never re-executed by reconciliation. Reconciliation may collect a scratch
path only after proving its owner no longer holds it; this is garbage collection,
not command recovery.

## World Reconciliation

A world reconcile first obtains one complete frozen Contract-world observation.
It either discovers the whole world, including an empty world, or reports
observation failure before selecting any Contract. There is no synthetic or
partial discovery result. It then returns each Contract's independent observed
effects and lags; one Contract's lag neither discards another's report nor
becomes a world-wide exception. Contract and world reports expose effects that
actually occurred and flat retryable lags, without inventing lifecycle state or
a second cleanup report.
