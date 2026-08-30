# Task CLI

The Task CLI is the user-facing adaptation of the separate Task product. It
owns Task command intent and Task-oriented presentation; [task.md](task.md)
owns all Task authority, lifecycle, relationships, persistence, and
concurrency judgment. Literal forms, flags, properties, and composition syntax
belong to executable leaf help and the parser, not this chapter.

## Commands and judgments

| Verb family | Purpose | Refusal and result boundary |
| --- | --- | --- |
| add, update | Create or change a Task fact. | The Task product decides identity, validation, no-op, and authority corruption; accepted results identify the changed Task. |
| start, stop, hold, resume, done, drop | Request a Task lifecycle change. | The Task product decides legal transition, target availability, and batch outcomes; a refusal or retry remains visible per requested Task. |
| show, ls, ready, blocked, query, tree | Read Task authority or a derived Task view. | Missing World, empty result, unavailable observation, and corrupt authority are never collapsed together. |
| compose | Submit a planning intent or ask for its plan. | Task owns aliasing, dependency judgment, admission, partial completion, and reusable recovery intent. |
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
Task text makes accepted work, a substantive refusal, retryable contention,
absence, and infrastructure failure distinguishable. JSON remains the same
public Task value, not a reduced text-derived format.

Composition presentation preserves the Task product's plan, accepted changes,
and recovery draft boundaries. In particular, an incomplete composition keeps
its reusable remaining intent separate from diagnostics about already admitted
work. The Task CLI does not calculate diffs, diagnose graph validity, or make
another admission decision merely to render output.
