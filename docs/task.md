# Task Product

Task is Keiyaku's independent planning product. It answers what work exists,
what may begin, and what is blocked. It is neither a prerequisite of Contract
work nor an extension of Contract, Git, or Akuma lifecycle. Contract modules
do not depend on Task; Task does not interpret Contract authority or Git state.

## World, identity, and custody

A Task board belongs to one World. The process edge resolves the World and the
directory-local namespace context before calling Task. Context is a convenience
default for a namespace, never Task, Contract, or Git authority: a complete
Task identity is sufficient without it, and an explicit selector prevails over
context. A managed worktree shares its repository's Task World; a deliberate
nested Task World remains separate.

Task identity is stable, human-readable, and names both its immutable namespace
and local member. Creation derives an identity under Task custody, rather than
accepting a caller-invented coordinate; changing a title or closing a Task does
not free, move, or rewrite that identity. A malformed context is a refusal for
an operation that needs the default, not a reason to silently select a broader
World. The caller may change context, but Task remains the only owner of its
meaning and durable representation.

Canonical Task Markdown is the sole durable Task authority. Its established
coordinate and contents must agree; manual edits are authoritative when they
remain intelligible as Task authority. Unrelated, malformed, or unowned
filesystem entries are not silently adopted as Tasks. Task state is intended to
be visible to ordinary repository review, but Task never stages, commits, or
changes Git references.

Task reads and writes are asynchronous, complete observations. A Task mutation
replaces one complete authority document; there is no competing synchronous
writer. A confirmed Task reset acts only on Task authority under Task custody,
leaves other product authority alone, and does not turn corruption into a
general-purpose deletion right.

## Lifecycle and relationships

A Task begins in an admitted working state and may be active, paused, or
terminal. Starting, stopping, holding, resuming, completing, and dropping are
Task-owned lifecycle judgments. Terminal Tasks release their dependents.
Readiness means an open Task has no unfinished prerequisites; blocked views
show work waiting on such prerequisites, while deliberately held work is not
misrepresented as either ready or blocked.

Task owns dependency, parentage, supersession, and related-work relationships.
They name complete Task identities and retain their declared order. A mutation
refuses a missing target, a self relation, a cycle, a duplicate that would
change no fact, an illegal lifecycle transition, or corrupted authority. It
does not invent a relationship from a directory, a Contract, a caller, or a
Git branch.

Creation and update retain author testimony only when a caller supplies it.
That testimony is not an identity registry, permission, Contract association,
or later inferred attribution. Task deliberately has no event-log, cached
readiness, counter, or partial-history promise: uncommitted Markdown edits are
authority, so a synthetic history would be dishonest.

## Views, composition, and recovery

Task's board, readiness, blocked, query, tree, and diagnostic views are
read-only interpretations of current Task authority. Growing row catalogues
are bounded observations: they retain the selected rows and whether the same
observation establishes another matching row, without becoming a traversal or
counting interface. Recent package catalogue order remains canonical Task
activity and reads its selected Task authority before projection; filesystem
metadata never becomes Task authority or a returned fact. A missing World, an empty board, a corrupt
document, and an unavailable observation remain distinct outcomes. Diagnosis
explains graph or authority problems but never repairs them merely by observing
them.

Composition accepts one Task planning intent and first judges it against one
board observation. A caller may ask for a plan or for admission. Accepted work
keeps the planner's dependency order without replacing unrelated Task facts.
If a write cannot finish because a competing writer changed authority, the
result distinguishes retryable contention from a substantive refusal and
retains the unadmitted intent as a reusable recovery draft. Composition does
not mutate Contract or Akuma authority.

## Coordination and the Contract boundary

Task serializes cooperating allocation and addressed writes, but serialization
is not truth: comparison with the predecessor observation detects a manual or
non-cooperating concurrent change and returns a retryable conflict. Lock
cleanup carries no Task fact and cannot alter authority.

Task Markdown deliberately contains no Contract association. Settlement owns
the optional TaskHolder relationship and its consequences; Task contributes a
complete identity and its lifecycle primitive only after Settlement has judged
the association. Task presentation and command spelling belong to
[cli-task.md](cli-task.md); package composition belongs to
[public-api.md](public-api.md).
