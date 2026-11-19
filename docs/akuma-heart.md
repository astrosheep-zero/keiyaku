# Akuma Heart

Heart is the sole durable Akuma authority. It owns Soul, Body, Turn, session,
activity, Tell, control, kill, hung, and seal facts; schemas, custody,
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
decoding. Schema versions 29 and 30 remain retained historical authority, but
ordinary access refuses them before acquiring a Heart writer. Wait surfaces that
permanent refusal without retrying it. Read-only SQLite bookkeeping can leave
empty transaction companions or update its coordination cache; it never
checkpoints or changes retained history. This build has no converter for those
versions. Current-format observation stays read-only. Reading a directly
supported predecessor reports that an upgrade is required without changing its
retained history or checkpointing its transaction log. Only an explicit Heart
write transaction can convert that predecessor. Conversion and version
publication commit only with an actual admitted fact change, preserving retained
facts, their relationships, and allocation high-water marks. Refusal, failure,
and an operation that changes no facts leave the predecessor and its retained
history intact.

To recover history, first stop all writers through their owning build. Once
quiescent, copy the entire Akuma custody directory, including the Heart's
transaction companions if present, the leash, and the execution log. Keep the
original untouched. Open only that copy in a separate World with a previously
installed compatible build, preserving its recognized identity and directory
layout. That build may upgrade the copy. If writers cannot be quiesced or no
compatible build is available, leave the original intact; it cannot be read by
this build.

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
recovery authority. An explicit progress report is instead an Akuma-owned
retained timeline fact: it preserves its exact text, time, and Body and Turn
correlation without ending execution or becoming input or provider narration.
Admission selects the latest open, non-hung Body and its latest open Turn in
one transaction; missing or closed execution refuses without recording.
The opening Turn initiator is observed in that same
admission, and its absence does not refuse a report. Reports share ordinary
timeline ordering, retention, and loss semantics, with no second inbox or cursor.
Where a native adapter admitted a bounded preview of a
generic tool's structured invocation arguments, Heart retains and projects that
narration with the same bound, and older name-only activity decoding and
presentation remain unchanged. A tool narration's native invocation identity is
retained and projected alongside it, scoped to its Turn, so the same work stays
correlatable across its start and its later witnessed completion under the one
durable order. The observed result text and per-file patch content an adapter
admitted when a call finished are retained under that same bound: a value
observed empty stays distinct from one never observed, and a record written
before those observations still decodes and still projects in its former shape,
without migration or rewriting. Compaction retains open work, pending Tells,
their required binding and delivery structure, and the interrupt frontier, while
old closed groups can become permanently unavailable. Obsolete automatic pending-input decisions are inert
historical evidence: execution and eligibility never interpret, resolve, or
remove them. Retention preserves references from that closed historical set
solely for storage integrity, without judging the obsolete decisions. A retained
Tell keeps the delivery evidence required to preserve its settled meaning;
historical retention never makes delivered input pending again. Existing
terminal receipts remain terminal.

A protected backlog is not itself a new reason to compact: maintenance is
amortized over new history and runs when protected work is released. Maintenance
progress can only avoid repeated work; it cannot decide a fact's liveness or
replace the retained history window. The public timeline derives one semantic row from each retained
fact in durable sequence order. Tool starts and completions remain independent
observations correlated by their native invocation identity within a Turn;
narration and an equal final answer remain independent observations too. No
projection moves, merges, or hides those retained identities. Current work and
reported changes derive directly from the latest retained frontier, without a
second timeline or store.

The latest retained activity time is the time of the last retained input,
provider narration, or explicit progress report in durable timeline order.
Turn transitions are lifecycle structure, not activity, whether opening or
ending a Turn. Status and roster consume this one Heart-owned definition;
absence of retained activity leaves its time unknown.

Recent roster observations derive their activity order and bounded extent solely
from that Heart projection. Custody metadata may conservatively bound which
unread Hearts need opening, but it is never returned, treated as activity, used
for lifecycle judgment, or allowed to choose membership, order, or extent.
Default inactive retirement measures semantic age from the later of that
activity time and durable life time, including Body settlement; it does not
count arbitrary Heart writes as activity. Filesystem metadata only bounds which
Hearts need opening and never decides staleness. Heart gains no durable activity
index, cache, daemon, or migration for that read or for retention. When those private bounds
cannot prove the semantic observation, the remaining candidates are observed
through fixed bounded concurrency before the roster observation is returned.

## Durable Facts And Judges

Soul freezes birth identity, recipe, cwd, origin, optional declared caller,
and the runtime-instruction opt-out. Absent caller attribution is valid and remains
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
pending tells or history. Elapsed time, a held leash alone, provider
events, or observer inference cannot manufacture it.

Kill admission classifies the latest Body in one transaction. A Body already
settled without a witness — a stranded life — is witnessed in place and its
matching stop control is consumed, so no stop is ever requested of a dead
process. A normally exited Body remains already stopped without a witness, and
a witnessed Body remains already killed. Hung custody is not a stop, even if an
end has been recorded.

Tell admission retains its optional submitting initiator alongside its input;
this is opaque integration attribution, with no participant lookup or historical
identity rewriting. Reusing the same Tell identity cannot replace that attribution. Turn admission
retains the opening input's initiator independently of later Tell retention,
Body succession, or the process producing its outcome. Binding a Tell to a Turn
adds its attributed initiator to that Turn's participant audience without
replacing the opening ownership attribution. An observer may read the
latest admitted Turn of one exact Body after that Body's terminal fact is durable;
no Turn, or a latest Turn without participants, yields no audience and never
falls back to an earlier Turn or runtime context.

Heart normalizes terminal evidence to the exact Tell at admission. A native
fence names only the Tells mapped to that fence in that Turn; missing mapping
refuses the receipt. Repeated evidence of the same kind for a Tell preserves
the first admitted timestamp. Only an exact undelivered witness is negative;
a matching opaque native kind cannot supply that meaning. Pending and told are
read models, not durable stages; only the absence of terminal evidence makes a
Tell pending. Terminal evidence follows the Tell's own retention, not the
retention of the Turn that supplied it.
Supported historical conversion preserves the original delivery, binding and
receipt evidence, including receipts with no retained mapping, and derives
terminal witnesses only for retained Tells.

Admitted Tell and that absence are the ordinary queue; no second durable
pending-input record is needed. A successful Turn can be followed by another
under the same Body after provider closure; failed execution leaves unrelated
input pending for an ordinary wake. Binding is Turn-side
evidence: a Tell may retain bindings for multiple historical Turns, and a
successor may bind and deliver the same stable Tell identity after a crash
between binding and delivery. A binding on an open Turn of the currently
running Body remains in that Body's active attempt; it does not settle the
Tell for later recovery.
Heart judges action confirmation in one consistent observation of the exact
Tell's delivery and terminal witnesses and relevant Turn, Body, and control.
Delivery proves submission to its owning Turn even if the Turn has since ended
or the Tell still lacks a stronger provider receipt. Binding, held custody,
and Body publication do not prove submission or queue acceptance. Historical
undelivered evidence is negative; missing or pruned proof is not success.
Lacking a durable witness can leave an already submitted Tell pending for a
later attempt. A terminal receipt settles the Tell without rollback. Neither
deadline nor kill settles or discards a Tell. Provider adapters own live processes and
never write Heart. Body is the only mover and tell-fact writer after Heart
admission. Product operations retain their native local owner and admission.
No observer store, capability registry, duplicate tell pipeline, or
cross-database atomicity exists.

## Boundary

Heart owns the single provider-neutral narration declaration used when activity
is written and read. Native adapters construct trusted neutral narration; neither
Body nor projection supplies a competing event interpretation. Validation of
retained activity preserves historical acceptance and never manufactures
execution, resume, fork, or recovery evidence.

Heart owns durable fact decoding and conditional judgments. Addressed Tell, Ask,
and Kill may carry a proved need for supported conversion to their native
admission without treating it as proof of birth. Addressing itself never
converts the Heart or interprets unsupported facts. Provider owns native
execution evidence; [akuma-provider.md](akuma-provider.md) defines its boundary.
The public surface consumes Heart's pure projection without accessing database
handles. Reset can classify predecessor custody without converting it. A supported
predecessor remains subject to the same stop and leash proof as current custody;
if observation requires an upgrade, reset stops before deletion. A failed
inspection is not proof of an unsupported format. Unsupported historical
custody is classified without interpreting its facts, as owned by
[akuma.md](akuma.md) and [world.md](world.md).
