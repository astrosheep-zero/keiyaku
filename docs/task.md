# Task Product

Task is Keiyaku's independent ledger of confirmed, unresolved work. It records
what is still owed and the prerequisites that block it. Reasoning and session
notes own plans; Task does not record execution progress. It is neither a prerequisite of Contract
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
Task authority paths contain no symlink component and all Task authority
observations and replacements use the same Task-owned physical path judgment.

Completed Task mutations provide a crash-durable namespace boundary: after a
successful creation, the canonical Markdown and every namespace directory
needed to reach it survive a crash as one accessible authority. A crash may
leave the predecessor or the complete successor, but never a partially
written document or an unreachable newly created namespace.

Task reads and writes are asynchronous, complete observations. A Task mutation
replaces one complete authority document. Keiyaku locks serialize cooperating
writers; an external writer may still race the portable compare-then-rename
sequence, so detection of that change is best effort rather than an arbitrary-
writer compare-and-swap guarantee. A confirmed Task reset acts only on Task
authority under Task custody, leaves other product authority alone, and does
not turn corruption into a general-purpose deletion right.

## Lifecycle and relationships

A Task is open, done, or dropped. Open means confirmed work remains unresolved;
done records completion and drop records that the work is no longer owed.
Completion and dropping are Task-owned judgments. Settlement may complete a
Task after Contract acceptance without making Contract lifecycle a Task fact.
No active or paused execution state exists. An unrecognized stored state is
corrupt authority, named in the failure rather than silently remapped.
Terminal Tasks release their dependents. Readiness means an open Task has no
unfinished prerequisites; blocked views show open work waiting on at least one
unfinished prerequisite.

One batch lifecycle request observes the board once, then judges its requested
Tasks in caller order against that observation as advanced by its own accepted
changes. A concurrent authority change remains a retry for its addressed Task;
it does not make later batch members silently observe a different board.
Batch cancellation stops at an item boundary; already completed items remain
durable and are observed through the board.

Task owns dependency, parentage, supersession, and related-work relationships.
They name complete Task identities and retain their declared order. Newly
declared missing targets and self relations are refused; duplicate entries in
relationship input are invalid. Illegal terminal transitions and corrupted
authority cannot be admitted. Cycles may be written: diagnostic views report
cycle components, and relationship trees mark cycles without recursing forever.
An unchanged update leaves authority and its timestamp unchanged. Task does
not invent a relationship from a directory, a Contract, a caller, or a Git
branch.

Creation and update retain author testimony only when a caller supplies it.
That testimony is not an identity registry, permission, Contract association,
or later inferred attribution. Task deliberately has no event-log, cached
readiness, counter, or partial-history promise: uncommitted Markdown edits are
authority, so a synthetic history would be dishonest.

## Views

A targeted Task read exposes only Task-owned outbound relations; reverse
relations are derived only by named board projections. Task's board,
readiness, blocked, query, tree, and diagnostic views are read-only
interpretations of current Task authority. Growing row catalogues
are bounded observations: they retain the selected rows and whether the same
observation establishes another matching row, without becoming a traversal or
counting interface. Recent package catalogue order remains canonical Task
activity and reads its selected Task authority before projection; filesystem
metadata never becomes Task authority or a returned fact. A missing World, an empty board, a corrupt
document, and an unavailable observation remain distinct outcomes. Diagnosis
explains graph or authority problems but never repairs them merely by observing
them.

## Coordination and the Contract boundary

Task serializes cooperating allocation and addressed writes, but serialization
is not truth: comparison with the predecessor observation best-effort detects a
manual or other non-cooperating concurrent change and returns a retryable
conflict when observed. Portable filesystems do not provide an arbitrary-writer
compare-and-swap guarantee between that comparison and replacement. Lock
cleanup carries no Task fact and cannot alter authority.

Task Markdown deliberately contains no Contract association. Settlement owns
the optional TaskHolder relationship and its consequences; Task contributes a
complete identity and its lifecycle primitive only after Settlement has judged
the association. Task presentation and command spelling belong to
[cli-task.md](cli-task.md); package composition belongs to
[public-api.md](public-api.md).
