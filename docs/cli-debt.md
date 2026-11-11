# Debt CLI

The Debt CLI is the user-facing adaptation of the separate Debt product. It
owns Debt command intent and Debt-oriented presentation; [debt.md](debt.md)
owns all Debt authority, lifecycle, relationships, persistence, and
concurrency judgment. Debt records confirmed unresolved work, not plans or
execution progress. Literal forms, flags, and properties belong to executable
leaf help and the parser, not this chapter.

## Commands and judgments

| Verb family | Purpose | Refusal and result boundary |
| --- | --- | --- |
| add, update | Create or change a Debt fact, including an addressed lifecycle judgment. | The Debt product decides identity, validation, legal transition, no-op, and authority corruption; an addressed update changes its requested facts and disposition atomically or writes neither on refusal. |
| query, tree | Read Debt authority or a derived Debt view. | Missing World, empty result, unavailable observation, and corrupt authority are never collapsed together. |
| doctor | Diagnose Debt authority and relationship health. | It reports; it never repairs. |

The Debt CLI adapts through the invocation facet, preserving native answers.
Root listing uses the existing Debt query's ordinary listing selection, and
addressed reads use the same Debt owner; listing defaults to open work. Readiness and blocking are query predicates.
The Debt CLI acquires only the input a selected verb permits and refuses an
ambiguous, surplus, or ill-formed request before invoking Debt. An explicit
namespace or complete identity selects its named coordinate; omission selects
the root namespace. The caller's directory, Contract, Git state, or Akuma
request never supplies an implicit namespace, identity, state, association,
or actor.

## Presentation

Text helps a caller scan complete Debt identity, current disposition, priority,
and title, then follows an entity with owned relationship and evidence detail
when requested. Complete identifiers and opaque evidence remain copyable; the
renderer may wrap prose but must not silently truncate or invent Debt facts.
Bounded Debt catalogues distinguish a complete observation from one with more
matching rows, but do not turn that distinction into counts, recovery advice,
or another traversal interface.
Debt text makes accepted work, a substantive refusal, retryable contention,
absence, and infrastructure failure distinguishable. JSON remains the same
public Debt value, not a reduced text-derived format. Addressed receipts use the
caller's selection for identity. Update receipts identify actual semantic field
changes, including a known unchanged result; they do not carry a projection-file
difference.
Catalogue presentation keeps work selection concise; exact activity testimony
belongs to targeted detail and decomposition belongs to the tree view.

Debt presentation exposes open, done, and dropped work. Ready and blocked are
derived views of open work and its prerequisites, never stored progress.
Settlement may close a Debt after Contract acceptance; the CLI owns no second
completion decision.
