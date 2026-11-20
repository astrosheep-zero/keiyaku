# Git Reconciliation

This chapter owns replayable Git topology effects, managed-worktree hooks, and
their transparent effects and lags. It repairs desired physical custody from
accepted facts and fresh external observation. Reconciliation is idempotent
across retries and process restarts, writes no journal fact, and cannot reverse
admission. It is the sole repair primitive for accepted-but-lagged Git effects.
Its one public entry is the collection composition's reconcile: the caller
supplies the Git-world coordinate under repair, the addressed Contract when one
Contract is meant, and the existing hook-retry choice, while the composition's
captured hooks feed the operation. A Contract handle repairs nothing and the
Git-world coordinate observes only.

## Replay And Concurrency

Each Contract effect decision is serialized independently. It reads current
Contract authority and current topology under that Contract's custody boundary,
then applies the effects that remain necessary. Ordinary admission does not use
this boundary; target placement uses the separate target fence from [git.md](git.md).
Different Contracts need no shared effect lock. A mutation that admitted newer
authority triggers reconciliation from that newer state. If authority moves
between outgoing and incoming custody, that attempt reports retryable lag
rather than restarting with the newer head.

Reconciliation reports meaningful completed physical movement and resource
retirement, plus typed issues for work it could not safely complete. Completed
Debt settlement remains visible even if releasing its association later fails.
Ephemeral recovery snapshots retain their identities at the invocation that
produced them. Unchanged observations and successful internal hook inventories
are not receipt content; a complete world pass omits Contracts with no effect or
issue. Unchanged topology can authorize local work but is not an effect.
Authority corruption remains an exception. A lag is safe to retry: every
replay begins from durable facts and fresh topology, never a process-local
receipt, progress marker, frozen hook list, detached runner, or recovery queue.
Confirmed reset is a separate Git-owned operation, not reconciliation.

Reconciliation lag failure semantics have one source of truth: the owner module's
exhaustive classifier determines whether a lag is incomplete physical repair or
observable retained residue. This judgment accompanies public diagnostics,
including retirement failures after completed repair; private custody names are
not public recovery categories. CLI rendering and process exit classification derive
from that classifier; they do not infer failure from names or add exceptions.
Extending the lag union therefore requires an explicit classification and
rendering decision, and fails typecheck until both are made.

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

Target-checkout recovery uses the same conservative follower as immediate
placement, only while the destination still names the exact accepted candidate.
A predecessor checkout can follow past disjoint staged, unstaged, and untracked
work; a whole candidate is inert. Only real contact, mixed state on the
movement's changed paths, or another unsupported checkout condition is retained
unchanged. A later explicit reconcile can follow once
eligibility is restored; there is no index-only repair, older-ancestor adoption,
or candidate recapture. Each checkout that
actually follows reports one physical movement. For a Contract destination,
recovery proves the same appointed incarnation and exact already-published
movement even if the destination has since become terminal; it never creates an
appointment or adopts a replacement. Workspace replacement, dependent following, and terminal
cleanup share the incoming destination fence with placement and follow.
Outgoing recovery finishes before incoming workspace repair begins. Git closes
that custody before the Library gives Settlement its opportunity. Terminal
cleanup reacquires custody and requires the same terminal authority that had
that opportunity. It proves the current topology and seal afresh, refusing
stale authority rather than removing a newly terminal workspace.

Pending delivery keeps the required tender and integration custody. Terminal
cleanup applies Git's sealed-byte and surviving-custodian law from
[git.md](git.md); reconciliation owns only the fresh topology observation and
physical replay. A worktree is removed before its appointment or redundant refs
are released. An appointment left after physical removal does not renew custody
that a surviving custodian still proves redundant. Reconciliation restores
missing refs when the recorded delivery lacks the required surviving custody.
Failure to restore one ref does not stop independent custody repair for the
other snapshot. Unavailable object evidence does not establish redundancy. It
can leave a ref custody diagnostic without blocking release of an appointment
whose physical absence is independently proved. Retention does not change
acceptance.

Reconciliation repairs each active Contract's admitted Verification snapshot
custody independently of delivery, using its current journal under publication
custody. Recovery uses the same exact association as admission and reuse. Only
the literal recorded commit proves availability; a Git replacement does not
count. A missing historical object is reported unavailable, never rebuilt or
substituted, and does not prevent repair of another snapshot. Terminal
reconciliation retires evidence-only custody independently of candidate
custody and leaves any live attempt's own custody intact.

Successful Git removal alone does not prove that the filesystem path is gone.
Cleanup confirms physical absence before reporting removal and releasing
custody. Observation failure or a leftover or recreated path retains custody
and reports lag; an unregistered residual path is not adopted merely to delete
it. A removal failure becomes that lag's diagnostic, and an attempted removal
never reports an unchanged worktree. Reconciliation re-observes such lag on
retry, without a background deletion queue or repeated destructive attempts in
one invocation. Cleanup is not a cross-process writer barrier, and runtime files
or lock-file presence alone do not establish whether another process is writing.

## Hooks And Scratch

Managed-worktree create and destroy hooks are physical effects, not Contract
lifecycle facts, settlement, or a general event system. Git receives opaque
commands from the library and runs an ordered phase in the managed worktree.
Hook authors must make a complete phase replay-safe: a retry reruns the current
phase from its beginning. A hook failure retains the worktree and required
custody, reports a lag, and cannot abandon or reverse the Contract. Hooks cannot
reenter mutation or reconciliation for the same Contract while that effect
decision owns its custody boundary.

Verification scratch has a separate, requirement-scoped lifecycle. It is never
a managed-worktree replay and has no resumable command state. Reconciliation
preserves each active Contract requirement's diagnostic scene independently and
collects all provably unowned scenes when the Contract is accepted or abandoned.
Collection or replacement for one requirement cannot erase another's scene.
Unassociated abandoned scratch remains collectable. Collection proves that no
live attempt owns the path; it never re-executes commands or recovers a run. A
collection that cannot confirm physical absence retains custody and reports a
diagnostic. Reconciliation never produces Verification testimony or satisfies
missing requirements.

Both physical owners share ordered command semantics while each keeps its own
failure meaning. The first failed command stops its phase, a retried phase
begins again from its start, and child retirement is awaited. Managed
reconciliation reports that failure as a lag and retains custody. Verification
scratch reports a failed setup as that attempt's environment failure, a
declaration result as its check verdict, and a failed cleanup as cleanup
evidence without rejudging the declaration. Managed hooks execute as the
worktree's own physical effect and do not adopt the invoking caller's
cancellation or output observation. Verification scratch setup runs with the
executing caller's environment, its cancellation boundary, and its ephemeral
output observation; scratch cleanup deliberately outlives caller cancellation
while retaining that environment and observation. Shared execution never
flattens those caller policies or lets one owner's failure category stand for
another's.

## World Reconciliation

A world reconcile first obtains one complete frozen Contract-world observation.
It either discovers the whole world, including an empty world, or reports
observation failure before selecting any Contract. There is no synthetic or
partial discovery result. Addressed repair, post-admission repair, and the
world pass give each Contract the same fresh reconciliation opportunity. In
discovery order, the world pass finishes one Contract's repair, projection,
Settlement, and eligible cleanup before starting the next. One Contract's lag
neither discards another's report nor becomes a world-wide exception.
Known-empty reports remain distinct from failed world observation.

Only an owner-recognized operational failure becomes reconciliation lag.
Programming failures and corrupt authority remain exceptional; an invocation
retains the physical observations already confirmed before they occurred.
