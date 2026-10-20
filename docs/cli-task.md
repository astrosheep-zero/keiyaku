# Task CLI

The Task CLI is the user-facing adaptation of the separate Task product. It
owns Task command intent and Task-oriented presentation; [task.md](task.md)
owns all Task authority, lifecycle, relationships, persistence, and
concurrency judgment. Task records confirmed unresolved work, not plans or
execution progress. Literal forms, flags, and properties belong to executable
leaf help and the parser, not this chapter.

## Commands and judgments

| Verb family | Purpose | Refusal and result boundary |
| --- | --- | --- |
| add, update | Create or change a Task fact. | The Task product decides identity, validation, no-op, and authority corruption; accepted results identify the changed Task. |
| done, drop | Close resolved work or work that is no longer owed. | The Task product decides legal transition, target availability, and batch outcomes; a refusal or retry remains visible per requested Task. |
| show, ls, ready, blocked, query, tree | Read Task authority or a derived Task view. | Missing World, empty result, unavailable observation, and corrupt authority are never collapsed together. |
| context | Observe or deliberately change the caller's default Task namespace. | Context is not authority and cannot retarget a complete Task identity. |
| doctor | Diagnose Task authority and relationship health. | It reports; it never repairs. |

The Task CLI acquires only the input a selected verb permits and refuses an
ambiguous, surplus, or ill-formed request before invoking Task. It does not
infer a namespace, Task identity, lifecycle state, association, or actor from
the caller's directory, Contract, Git state, or Akuma request.

## Presentation

Text helps a caller scan complete Task identity, current disposition, priority,
and title, then follows an entity with owned relationship and evidence detail
when requested. Complete identifiers and opaque evidence remain copyable; the
renderer may wrap prose but must not silently truncate or invent Task facts.
Bounded Task catalogues distinguish a complete observation from one with more
matching rows, but do not turn that distinction into counts, recovery advice,
or another traversal interface.
Task text makes accepted work, a substantive refusal, retryable contention,
absence, and infrastructure failure distinguishable. JSON remains the same
public Task value, not a reduced text-derived format.

Task presentation exposes open, done, and dropped work. Ready and blocked are
derived views of open work and its prerequisites, never stored progress.
Settlement may close a Task after Contract acceptance; the CLI owns no second
completion decision.
