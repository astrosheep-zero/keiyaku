# Contract Model

The journal is the sole durable lifecycle authority. Git storage and effects,
worktrees, process outcomes, and read models derive from it; none is a second
state store. v4 accepts no compatibility or migration authority.

## Durable Authority

A Contract begins with immutable coordinates and opaque terms. Amendments
replace the effective terms but never the coordinates. The journal records the
closed Contract vocabulary needed to bind and amend terms, retain a delivery
and any reintegration, admit producer testimony, name an arc, mark the delivery
phase, and reach one terminal outcome. The canonical journal and its entry
identities are the handoff and recovery receipt.

The journal retains lifecycle facts and bounded intent only. It does not retain
raw process logs, patches, artifacts, telemetry, producer caches, or a
compatibility projection. Times, counts, elapsed durations, history order, and
combined Contract/Akuma views are read-time presentation, never independent
authority. Optional actor testimony is not lifecycle identity or gate input.

A journal fold is a current read model, not stored authority. It exposes one
coherent Contract state or explicit absence; a missing observation entry is a
broken observation, not another representation of absence. A Contract has at
most one terminal outcome. An impossible fold, malformed durable authority, or
partial admission is corruption, surfaced at the package boundary as
`AuthorityCorruptionError`, rather than a normal refusal or retry.

A captured execution checkpoint is an interpretation, not testimony that the
current invocation admitted anything. Completion may advance an existing
Contract without inventing a leading act. Only newly admitted facts belong to
that completion's execution progress; historical facts remain in its observed
journal. Combining progress with a leading receipt preserves the addressed
Contract's identity and does not turn a dependent's head into the leading head.
Execution progress is transient and never a second recovery authority.
Confirmed publication is recorded before trailing interpretation or effects can
fail. Receipt identity is the admitted fact identity: exact repeat observations
do not duplicate the invocation's facts, while conflicting bytes for that
identity remain corruption. The addressed Contract's receipt head is not a
later observation and cannot be replaced by another Contract's completion.

## Identity And Custody

Public coordinates are complete, prefixed identities. Each product family owns
its constructor, validation, collision policy, and persistence; consumers do
not repair a bare or partial identity. Human-facing identity construction is
stable and portable, while physical filesystem names remain Git's concern.
Aliases, globs, and other convenience selectors are read-time library input and
are never persisted as another identity.

Git alone mints and physically validates snapshot and patch identities. A
delivery holds one candidate identity relative to the immutable Contract start;
reintegration may change placement topology but cannot create a second candidate
identity. Core treats these as opaque values and knows neither Git objects nor
Markdown sections.

## Dependency Direction

Pact folds authority and makes pure legal decisions. The document boundary
prepares caller terms. Git observes, persists, admits, and performs physical
effects. Protocol is the only join between pact decisions and Git. Execution
producers use the shared process runtime and return to protocol. Library
composes those capabilities into package operations; CLI only adapts invocation
and renders adjudicated public values.

No lower or outer layer may skip this direction. Pact has no repository,
process, clock, working-directory, or physical-object authority. Core has no
document grammar or producer-specific rules. Persisted data exists only when a
named invariant and reader need it; otherwise it would be a competing state
surface.
