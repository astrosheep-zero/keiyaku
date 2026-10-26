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
| add, update | Create or change a Debt fact. | The Debt product decides identity, validation, no-op, and authority corruption; accepted results identify the changed Debt. |
| done, drop | Close resolved work or work that is no longer owed. | The Debt product decides legal transition, target availability, and batch outcomes; a refusal or retry remains visible per requested Debt. |
| show, ls, ready, blocked, query, tree | Read Debt authority or a derived Debt view. | Missing World, empty result, unavailable observation, and corrupt authority are never collapsed together. |
| context | Observe or deliberately change the caller's default Debt namespace. | Context is not authority and cannot retarget a complete Debt identity. |
| doctor | Diagnose Debt authority and relationship health. | It reports; it never repairs. |

The Debt CLI acquires only the input a selected verb permits and refuses an
ambiguous, surplus, or ill-formed request before invoking Debt. It does not
infer a namespace, Debt identity, lifecycle state, association, or actor from
the caller's directory, Contract, Git state, or Akuma request.

Observing a context and deliberately changing one are different judgments. Only
an operation that consumes the default resolves the installed context, so a
malformed installed context refuses that work and never blocks a deliberate
change. A change validates the supplied namespace before it touches anything,
replaces the installed default durably, and reports the default later callers
resolve; it reads no previous context and repairs nothing by implication.

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
public Debt value, not a reduced text-derived format.

Debt presentation exposes open, done, and dropped work. Ready and blocked are
derived views of open work and its prerequisites, never stored progress.
Settlement may close a Debt after Contract acceptance; the CLI owns no second
completion decision.
