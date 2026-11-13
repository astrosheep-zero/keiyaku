# Debt Product

Debt is Keiyaku's independent ledger of confirmed, unresolved work. It records
what is still owed and the prerequisites that block it. Debt is neither a
planner nor an execution-progress tracker. It is neither a prerequisite of
Contract work nor an extension of Contract, Git, or Akuma lifecycle. Contract modules
do not depend on Debt; Debt does not interpret Contract authority or Git state.

## World, identity, and custody

A Debt board belongs to one World. The invocation facet resolves that World
before calling Debt. Every catalogue covers that World's ledger. A managed
worktree shares its repository's Debt World; a deliberate nested Debt World
remains separate.

Debt identity is stable, human-readable, and names one member of the flat World
ledger. Creation derives an identity under Debt custody, rather than accepting
a caller-invented coordinate; changing a title or closing a Debt does not free,
move, or rewrite that identity.

Canonical Debt Markdown is the sole durable Debt authority. Its established
coordinate and contents must agree; manual edits are authoritative when they
remain intelligible as Debt authority. Unrelated, malformed, or unowned
filesystem entries are not silently adopted as Debts. Debt state is intended to
be visible to ordinary repository review, but Debt never stages, commits, or
changes Git references.
Debt authority paths contain no symlink component and all Debt authority
observations and replacements use the same Debt-owned physical path judgment.

Completed Debt mutations durably publish the canonical Markdown directly in the
World ledger. A crash may leave the predecessor or the complete successor, but
never a partially written document or an inaccessible completed creation.

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

Creation records open work with an empty current explanation. An addressed update
owns ordinary facts and explicit disposition as one indivisible Debt mutation.
Every explicit transition among open, done, and dropped is legal, including
reopening and changing between terminal dispositions. Omission preserves a fact;
replacement supplies its complete current value, and an empty body, explanation,
or prerequisite selection clears it. Repeating current facts leaves authority
and its timestamp unchanged. Invalid requested facts leave the entire mutation
unwritten. Explanations describe the current situation rather than a history.
Settlement retains its internal idempotent completion judgment; there is no
public terminal batch operation.

Debt owns prerequisite dependencies only. They name complete Debt identities
and retain their declared order. Newly declared missing targets, self dependencies,
and duplicate input entries are refused. Cycles may be written and diagnosis
reports their components. Reopening a prerequisite blocks open dependents on
fresh observation without writing those dependents, changing closed dependents,
or reversing an accepted Contract. Debt does not invent a dependency from a
directory, a Contract, a caller, or a Git branch.

Debt retains no creator attribution and does not infer authorship from its
caller. Persistence reads interpret known content and ignore unknown content;
required content and known value constraints remain mandatory. Untouched
authority is preserved, and an ordinary update writes only current content.
An older reader deliberately does not interpret unknown future semantics.
Creation and other public caller inputs remain closed.
Debt deliberately has no event-log, cached
readiness, counter, or partial-history promise: uncommitted Markdown edits are
authority, so a synthetic history would be dishonest.

## Views

Invocation listing defaults to open work; callers may explicitly select terminal
work or all work. Lifecycle selection precedes the bound, and rows
are ordered by priority and then canonical identity. Debt offers native listing
and graph views without an expression language or caller-selected sorting.
Catalogues summarize current work rather than repeat
its full document or activity testimony. Native singular reads retain resolved
prerequisites; unavailable endpoints remain explicit. Batch reads distinguish
complete, partial and missing selection while preserving readable peers and the
identity of each missing member. Blocked views identify every unresolved
prerequisite and distinguish missing endpoints. Debt's board, readiness, blocked,
and diagnostic views are read-only interpretations of current Debt authority. Growing row catalogues
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
cleanup carries no Debt fact and cannot alter authority. When cleanup fails
after a confirmed write, the completed judgment retains a compact diagnostic;
cleanup failure never turns committed work into a refusal or retry.

Debt Markdown deliberately contains no Contract association. Settlement owns
the optional DebtHolder relationship and its consequences; Debt contributes a
complete identity and its lifecycle primitive only after Settlement has judged
the association. Debt presentation and command spelling belong to
[cli-debt.md](cli-debt.md); package composition belongs to
[public-api.md](public-api.md).
