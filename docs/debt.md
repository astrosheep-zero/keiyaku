# Debt Product

Debt is Keiyaku's independent ledger of confirmed, unresolved work. It records
what is still owed and the prerequisites that block it. Debt is neither a
planner nor an execution-progress tracker. It is neither a prerequisite of
Contract work nor an extension of Contract, Git, or Akuma lifecycle. Contract modules
do not depend on Debt; Debt does not interpret Contract authority or Git state.

## World, identity, and custody

A Debt board belongs to one World. The process edge resolves the World and the
directory-local namespace context before calling Debt. The directory-local
context is the nearest one the invocation directory or an ancestor declares, and
that walk includes the World boundary itself: a nearer context overrides a
broader one, and the walk never continues above the boundary or adopts an outer
context as a fallback. Context is a convenience default for a namespace, never
Debt, Contract, or Git authority: a complete Debt identity is sufficient without
it, and an explicit selector prevails over context. A managed worktree shares
its repository's Debt World; a deliberate nested Debt World remains separate.

Debt identity is stable, human-readable, and names both its immutable namespace
and local member. Creation derives an identity under Debt custody, rather than
accepting a caller-invented coordinate; changing a title or closing a Debt does
not free, move, or rewrite that identity. A malformed context is a refusal for
an operation that needs the default, not a reason to silently select a broader
World. The caller may change context, but Debt remains the only owner of its
meaning and durable representation.

Existing ledger identities and relationships retain their meaning across the
product rename. An unmigrated board is unavailable, not an empty new ledger;
reading it never performs an implicit migration or discards its testimony.

Canonical Debt Markdown is the sole durable Debt authority. Its established
coordinate and contents must agree; manual edits are authoritative when they
remain intelligible as Debt authority. Unrelated, malformed, or unowned
filesystem entries are not silently adopted as Debts. Debt state is intended to
be visible to ordinary repository review, but Debt never stages, commits, or
changes Git references.
Debt authority paths contain no symlink component and all Debt authority
observations and replacements use the same Debt-owned physical path judgment.

Completed Debt mutations provide a crash-durable namespace boundary: after a
successful creation, the canonical Markdown and every namespace directory
needed to reach it survive a crash as one accessible authority. A crash may
leave the predecessor or the complete successor, but never a partially
written document or an unreachable newly created namespace.

Debt reads and writes are asynchronous, complete observations. A Debt mutation
replaces one complete authority document. Keiyaku locks serialize cooperating
writers; an external writer may still race the portable compare-then-rename
sequence, so detection of that change is best effort rather than an arbitrary-
writer compare-and-swap guarantee. A confirmed Debt reset acts only on Debt
authority under Debt custody, leaves other product authority alone, and does
not turn corruption into a general-purpose deletion right.

## Lifecycle and relationships

A Debt is open, done, or dropped. Open means confirmed work remains unresolved;
done records completion and drop records that the work is no longer owed.
Completion and dropping are Debt-owned judgments. Settlement may complete a
Debt after Contract acceptance without making Contract lifecycle a Debt fact.
No active or paused execution state exists. An unrecognized stored state is
corrupt authority, named in the failure rather than silently remapped.
Terminal Debts release their dependents. Readiness means an open Debt has no
unfinished prerequisites; blocked views show open work waiting on at least one
unfinished prerequisite.

One batch lifecycle request observes the board once, then judges its requested
Debts in caller order against that observation as advanced by its own accepted
changes. A concurrent authority change remains a retry for its addressed Debt;
it does not make later batch members silently observe a different board.
Batch cancellation stops at an item boundary; already completed items remain
durable and are observed through the board.

Debt owns dependency, parentage, supersession, and related-work relationships.
They name complete Debt identities and retain their declared order. Newly
declared missing targets and self relations are refused; duplicate entries in
relationship input are invalid. Illegal terminal transitions and corrupted
authority cannot be admitted. Cycles may be written: diagnostic views report
cycle components, and relationship trees mark cycles without recursing forever.
An unchanged update leaves authority and its timestamp unchanged. Debt does
not invent a relationship from a directory, a Contract, a caller, or a Git
branch.

Creation and update retain author testimony only when a caller supplies it.
That testimony is not an identity registry, permission, Contract association,
or later inferred attribution. Debt deliberately has no event-log, cached
readiness, counter, or partial-history promise: uncommitted Markdown edits are
authority, so a synthetic history would be dishonest.

## Views

A targeted Debt read exposes only Debt-owned outbound relations; reverse
relations are derived only by named board projections. Debt's board,
readiness, blocked, query, tree, and diagnostic views are read-only
interpretations of current Debt authority. Growing row catalogues
are bounded observations: they retain the selected rows and whether the same
observation establishes another matching row, without becoming a traversal or
counting interface. Recent package catalogue order remains canonical Debt
activity and reads its selected Debt authority before projection; filesystem
metadata never becomes Debt authority or a returned fact. A missing World, an empty board, a corrupt
document, and an unavailable observation remain distinct outcomes. Diagnosis
explains graph or authority problems but never repairs them merely by observing
them.

## Coordination and the Contract boundary

Debt serializes cooperating allocation and addressed writes, but serialization
is not truth: comparison with the predecessor observation best-effort detects a
manual or other non-cooperating concurrent change and returns a retryable
conflict when observed. Portable filesystems do not provide an arbitrary-writer
compare-and-swap guarantee between that comparison and replacement. Lock
cleanup carries no Debt fact and cannot alter authority.

Debt Markdown deliberately contains no Contract association. Settlement owns
the optional DebtHolder relationship and its consequences; Debt contributes a
complete identity and its lifecycle primitive only after Settlement has judged
the association. Debt presentation and command spelling belong to
[cli-debt.md](cli-debt.md); package composition belongs to
[public-api.md](public-api.md).
