# Akuma Heart

Heart is the sole durable Akuma authority. It owns Soul, Body, Turn, session,
activity, Tell, request, control, kill, hung, and seal facts; schemas, custody,
transactions, and public projections. Private database layout and row mechanics
are not law.

## Custody And Timeline

Heart observation and mutation are asynchronous at its owner boundary. Each
read observes one consistent snapshot; each mutation is one bounded owner
transaction. These implementation boundaries do not create synchronous public
APIs, a cache, a daemon, or a queue. Existing Heart custody is opened without
creating it; only a true absence becomes absence. Corruption and unsupported
schema are hard failures, never partial reading, silent repair, migration, or
compatibility decoding.

The retained timeline is the sole durable execution order. A Body can drive
multiple Turns; every admitted Turn starts before provider work and either ends
once with an answer or typed failure, or remains open after interruption or
loss. Heart never fabricates a provider outcome. Sessions record a provider
native resume promise when granted. A later Body resumes only that promise; it
never reconstructs a broken native session or treats a missing session as a
resume claim. An answered Turn may retain an exact provider fork point; failure
and an answer without such a point remain non-forkable.

Activity is bounded retained provider narration, not a raw payload log or a
recovery authority. Compaction retains open work, pending tells, and required
structure, while old closed groups can become permanently unavailable. The public
timeline projector is pure and derives snapshots, gaps, history loss, activity
selection, and reported changes from this one sequence. These projections never
become facts or cursors of a second store.

Recent fleet observations derive their activity order and bounded extent solely
from that Heart projection. Custody metadata may conservatively bound which
unread Hearts need opening, but it is never returned, treated as activity, used
for lifecycle judgment, or allowed to choose membership, order, or extent.
Heart gains no durable activity index, cache, daemon, or migration for that
read. When those private bounds cannot prove the semantic observation, the
remaining candidates are observed through fixed bounded concurrency before it
is returned.

## Durable Facts And Judges

Soul freezes birth identity, recipe, cwd, origin, restraint, and permissions.
Body facts name lifecycle custody but persist no process coordinate or
reconstructable signal authority. A seal shares the leash's atomic birth judge,
closing a coordinate permanently. Stop and pause are distinct transient control
facts; a later leash holder can clear abandoned control but cannot claim physical
custody of its predecessor. Kill witnesses one exact, explicitly settled Body;
a successor supersedes its life projection without deleting history.

Hung evidence records failure of a Body's owned provider custody to retire. It
permanently gates same-identity succession and never clears, changes sessions,
pending tells, requests, or history. Elapsed time, a held leash alone, provider
events, or observer inference cannot manufacture it.

Tell facts retain admission and only named delivery/terminal-receipt witnesses.
They fold to `pending` or `told`; these are read models, not durable stages.
Provider submission can be at least once: lacking durable witness leaves a Tell
pending for a later Body, while a terminal witness settles it without rollback.
Kill never settles or discards a Tell. Request facts are the sole durable Body
Request authority and service reference; their lifecycle is owned by
[akuma-requests.md](akuma-requests.md).

Heart validates generic request lifecycle and authenticates the caller's
permission decision, but does not interpret action vocabulary, payload, service
schema, or operation semantics. Provider adapters own live processes and never
write Heart. Body is the only mover and tell-fact writer after Heart admission.
No observer store, capability registry, duplicate tell pipeline, or
cross-database atomicity exists.

## Boundary

Heart owns durable fact decoding and conditional judgments. Provider owns native
execution evidence; [akuma-provider.md](akuma-provider.md) defines its boundary.
The public surface consumes Heart's pure projection without accessing database
handles. Reset can classify unsupported recognized custody without interpreting
its facts, as owned by [akuma.md](akuma.md) and [world.md](world.md).
