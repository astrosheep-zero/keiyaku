# Akuma Heart

Heart is the sole durable Akuma authority. It owns Soul, Body, Turn, session,
activity, Tell, request, control, kill, hung, and seal facts; schemas, custody,
transactions, and public projections. Private database layout and row mechanics
are not law.

## Custody And Timeline

Heart observation and mutation are asynchronous at its owner boundary. Each
read observes one consistent snapshot; each mutation is one bounded owner
transaction. An operation may reuse decoded facts and pure projections only
when Heart's current observation proves their complete inputs equivalent.
Such reuse never substitutes for fresh lifecycle or custody observation, never
survives a failed read, and ends with the observing operation. A bounded observer
may retain read resources between observations, but never a transaction or stale
snapshot; removal or replacement of Heart invalidates that retained custody, and
every observation still validates current authority. Body control observation
wakes execution only when its control or pending-input facts change. These
implementation boundaries do not create synchronous public APIs, a daemon,
a queue, or a persistent cache. Existing Heart custody is opened without
creating it; only a true absence becomes absence. Corruption and unsupported
schema are hard failures, never partial reading, silent repair, or compatibility
decoding. The one explicitly supported predecessor format upgrades automatically
at ordinary open, including first observation. Its structural conversion and
version publication are atomic, preserve all retained facts and relationships,
and serialize concurrent openers under Heart's existing mutation custody. A
failed conversion leaves the old authority intact and fails the open. Other
versions remain unsupported; current-format observation stays read-only.

Contended mutation admission waits without blocking unrelated observations or
control handling, within a bounded acquisition interval. Cancellation may stop
that wait before admission; it never replays or retracts an entered transaction.
Once acquired, the owner executes its mutation once and preserves any execution
or commit failure rather than treating it as permission to repeat business work.

The retained timeline is the sole durable execution order. A Body can drive
multiple Turns; every admitted Turn starts before provider work and either ends
once with an answer, typed failure, or proven controlled cancellation, or remains
open after unproven execution loss. Cancellation invents neither an answer nor a
failure diagnostic. Heart never fabricates a provider outcome. Sessions record a
provider native resume promise when granted. A later Body resumes only that promise; it
never reconstructs a broken native session or treats a missing session as a
resume claim. An answered Turn may retain an exact provider fork point; failure,
cancellation, and an answer without such a point remain non-forkable.

Activity is bounded retained provider narration, not a raw payload log or a
recovery authority. Where a native adapter admitted a bounded preview of a
generic tool's structured invocation arguments, Heart retains and projects that
narration with the same bound, and older name-only activity decoding and
presentation remain unchanged. A tool narration's native invocation identity is
retained and projected alongside it, scoped to its Turn, so the same work stays
correlatable across its start and its later witnessed completion under the one
durable order. The observed result text and per-file patch content an adapter
admitted when a call finished are retained under that same bound: a value
observed empty stays distinct from one never observed, and a record written
before those observations still decodes and still projects in its former shape,
without migration or rewriting. Compaction retains open work, pending tells, and
required structure, while old closed groups can become permanently unavailable. An open
pending-Tell disposition retains its frozen Tell identities and the delivery
structure needed to prove them, including Tells already witnessed as told.
Proof consumption and release of those dependencies are one Heart mutation.
Control can instead supersede an automatic disposition without settling or
discarding its Tell identities. Successor admission judges that exact decision
against current control and kill evidence under Heart mutation custody; an old
automatic launch cannot cross a witnessed kill. The resolved decision remains
evidence of that Body's one decision; duplicate resolution does not reread
retired members or capture later Tells. A protected backlog is not itself a new
reason to compact: maintenance is amortized over new history and runs when
protected work is released. Maintenance progress can only
avoid repeated work; it cannot decide a fact's liveness or replace the retained
history window. The public
timeline projector is pure and derives snapshots, gaps, history loss, activity
selection, and reported changes from this one sequence. These projections never
become facts or cursors of a second store.
When a complete Turn's exact final non-truncated narration equals its answered
outcome, that projector omits only that projected duplicate. Heart retains both
source facts; renderers never decide this fold. The outcome it produces names
the omitted narration's durable identity, so the correlation is projected
evidence rather than a consumer's re-comparison of text, and truncated or
differing narration is never named as that duplicate.

Recent roster observations derive their activity order and bounded extent solely
from that Heart projection. Custody metadata may conservatively bound which
unread Hearts need opening, but it is never returned, treated as activity, used
for lifecycle judgment, or allowed to choose membership, order, or extent.
Default inactive retirement uses the same Heart timestamps and life projection
as its semantic age; filesystem metadata only bounds which Hearts need opening
and never decides staleness. Heart gains no durable activity index, cache,
daemon, or migration for that read or for retention. When those private bounds
cannot prove the semantic observation, the remaining candidates are observed
through fixed bounded concurrency before the roster observation is returned.

## Durable Facts And Judges

Soul freezes birth identity, recipe, cwd, origin, optional declared caller,
restraint, and permissions. Absent caller attribution is valid and remains
absent without migration or backfill; malformed present attribution is corrupt
rather than unknown. Caller admission and durable decoding share one validation
meaning. Attribution introduces no cross-World lookup or second identity store.
One recipe member stays mutable: the current runtime model, the single model
this Akuma is admitted to run. Birth seeds it from the admitted selection, which
is configured intent rather than proof of native use; afterwards only the exact
latest running Body may replace it from that attempt's own native evidence, and
evidence whose replacement is unnamed clears it again. Nothing writes a model
anywhere else, so activity compaction can neither lose nor resurrect one, and a
session admits a resume coordinate rather than a model: an obsolete copy reads
as absent and never overrides the current value.
Body facts name lifecycle custody but persist no process coordinate or
reconstructable signal authority: a launch runtime is a live coordinate of the
waking process, never durable Heart authority. A seal shares the leash's atomic
birth judge, closing a coordinate permanently. Stop and interrupt are distinct
transient controls. An interrupt retains the admitted Tell and a barrier naming
its predecessor Body and Tell frontier in one Heart admission. Concurrent
interrupts join that barrier in Tell order without replacing its predecessor or
frontier. Repeating a Tell identity keeps its admitted input and never reissues
control; changed input refuses. The predecessor cannot select, bind, deliver,
receipt, or terminalize frontier-and-later input. Earlier pending input remains
available for successor recovery, and retention preserves the barrier's proof
until it is consumed.

Completion consumes only the exact barrier after explicit non-hung predecessor
settlement under the leash. Free custody or elapsed time alone is not proof,
and refusal never clears the barrier. A stale helper cannot consume newer
control or claim custody of a successor. A legacy pause without a frontier
remains readable and can be cleared only by the same settlement proof, without
inventing a Tell. Malformed present frontier is corruption, never legacy state.
Kill witnesses one exact, explicitly settled Body; a successor supersedes its
life projection without deleting history.

Hung evidence records failure of a Body's owned provider custody to retire. It
permanently gates same-identity succession and never clears, changes sessions,
pending tells, requests, or history. Elapsed time, a held leash alone, provider
events, or observer inference cannot manufacture it.

Kill admission classifies the latest Body in one transaction. A Body already
settled without a witness — a stranded life — is witnessed in place and its
matching stop control is consumed, so no stop is ever requested of a dead
process. A normally exited Body remains already stopped without a witness, and
a witnessed Body remains already killed.

Tell admission retains its optional submitting initiator alongside its input;
reusing the same Tell identity cannot replace that attribution. Turn admission
retains the opening input's initiator independently of later Tell retention,
Body succession, or the process producing its outcome. Binding a Tell to a Turn
adds its attributed initiator to that Turn's participant audience without
replacing the opening ownership attribution. An observer may read the
latest admitted Turn of one exact Body after that Body's terminal fact is durable;
no Turn, or a latest Turn without participants, yields no audience and never
falls back to an earlier Turn or runtime context.

Tell facts retain admission and only named delivery/terminal-receipt witnesses.
They fold to `pending` or `told`; these are read models, not durable stages.
Pending selection is governed by the absence of a terminal receipt, not by
historical Turn binding or an unresolved disposition. Binding is Turn-side
evidence: a Tell may retain bindings for multiple historical Turns, and a
successor may bind and deliver the same stable Tell identity after a crash
between binding and delivery. A binding on an open Turn of the currently
running Body remains in that Body's active attempt; it does not settle the
Tell for later recovery.
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

Heart owns the single provider-neutral narration declaration used when activity
is written and read. Native adapters construct trusted neutral narration; neither
Body nor projection supplies a competing event interpretation. Validation of
retained activity preserves historical acceptance and never manufactures
execution, resume, fork, or recovery evidence.

Heart owns durable fact decoding and conditional judgments. Provider owns native
execution evidence; [akuma-provider.md](akuma-provider.md) defines its boundary.
The public surface consumes Heart's pure projection without accessing database
handles. Reset can classify unsupported recognized custody without interpreting
its facts, as owned by [akuma.md](akuma.md) and [world.md](world.md).
