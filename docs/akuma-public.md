# Akuma Public Surface

This chapter owns the small `Akuma` root product surface and its lifecycle
evidence. Exact TypeScript shapes, field budgets, and rendering belong to
declarations, help, and executable specifications.

The public caller path is `Akuma.birth`, synchronous `Akuma.select`, then `Akuma.tell` or `Akuma.ask`. Birth submits no prompt; selection performs no read. A selected Akuma exposes its identity, status, Tell admission with optional text answer observation, and structured Ask, along with the lifecycle-only idle, history, and kill observations.
`Akumas` owns World selection, Alias and Contract selector resolution, Dispatch
and DebtHolder association, and plural selection around this product;
those concerns do not become single-Akuma handle methods. `Akuma` remains
independent of Repo and selector composition.

A selected Akuma may record an explicit progress report on its current execution
as observed at admission; it is refused when the Akuma is not executing.
Its result means recorded, not received, and acknowledges only the retained
report's timeline identity. Full authored text and execution correlations stay
in Heart, exact history, and the native report signal; optional notification failure
cannot undo the fact. Reports appear as distinct rows in the same public history
and stream, under their existing sequence and retention meaning. They are not
answers, and neither completion observation nor final-answer selection changes.
An exact retained report is independently readable by its own timeline identity,
even while its Turn is open. That read observes no Turn outcome; a pruned or
wrong-kind coordinate remains unknown rather than selecting other evidence.

Addressed status observes the Akuma's current Heart surveillance audience from
its own frontier. A known empty audience is not unavailable. This is an open
observation of membership, not a delivery receipt or a lifecycle predicate.
Wait, the board, and the roster do not enrich their observations with it.

## One Public Timeline

Status and history derive from one retained Heart timeline in durable sequence
order. Each retained fact remains independently visible. A tool's start and
completion keep their own durable identities, correlated by the producer's
native invocation identity within the Turn. Completion neither relocates nor
replaces the start, and observation synthesizes no tool duration or execution
state. Narration remains visible even when it equals a later final answer.
Recent status, paged history, and live snapshots share the Akuma owner's bounded
text projection of retained activity. The snapshot keeps the retained identity
and makes omission visible; it is not a machine transcript. Current work and
reported changes derive from the same evidence without interpreting preview text.
A born status reports its frozen execution directory and provider, and the
Akuma's one current model. The model is the selection its birth admitted until
the running Body's own native evidence replaces it, and that evidence afterwards.
The admitted selection is configured intent, not proof that a native runtime used
it. An absent model is unknown, never a configured default, a stale session
copy, or a previous attempt's answer; an explicit change whose native replacement
is unnamed returns the model to unknown. Descriptive birth origin, caller,
provider environment, opaque configuration and system prompts remain outside
this actionable status. A standalone handle may retain its frozen birth
observation; composed addressed status answers current work without repeating it.
For an open Turn, current-work status distinguishes an observed native approval
wait from ordinary execution and names the pending action, resources, and tool
when the provider supplied them. The current wait remains visible independently
of the ordinary activity window; an answered request clears it, and a closed
Turn never carries it forward. This is observed work, not a new life state,
permission policy, or a channel for answering the request. Absence of such
evidence never proves that the provider cannot be waiting.

A status reports semantic current work directly from the retained frontier:
open or idle work, pending input, the latest Turn and known outcome, and
coordinates that address retained evidence rather than internal execution mirrors.
A bounded current-action summary prioritizes pending approval, then the latest unmatched tool start on an open Turn, then the latest
speech or delivered input. Its clipping remains visible. Optional recent detail
is a fixed small tail of frontier rows, independent of approval, tool, and input
evidence; there are no pinned rows, inline gaps, or shared detail budgets.
Status never proves native liveness, and an absent summary proves neither
inactivity nor idle. Its latest retained activity time has the same Heart-owned
meaning as roster activity ([akuma-heart.md](akuma-heart.md)). Exact reads and
native timeline streams preserve the complete typed evidence.

Reported changes summarize successful file-change completions on the latest
Turn. Distinct paths retain their latest-change order and accumulate known
sizes; any constituent with unknown size leaves that path's total unknown.
The bounded summary prefers changes lexically inside the frozen execution
directory and counts outside paths separately. Containment uses path spelling,
without filesystem, symlink, or case canonicalization, and grants no filesystem
authority. This advisory summary is neither a file ledger nor a retained fact.

Live consumers may present the native current-work summary as a replaceable
observation, replacing all prior work and life facts on each callback. Ask uses
that bounded presentation rather than reconstructing a timeline or settlement
cursor. Its elapsed clock measures the caller's observation, not worker liveness,
and its conclusion belongs only to the exact admitted input's native outcome.
Status and history are frozen projections, so they never assert liveness. Native
timeline streams retain their complete windows and ordinary retention semantics;
consumer presentation neither expands nor removes that capability.

Placement discharge of reported changes for an accepted associated Contract
belongs to composite observation in [kanshi.md](kanshi.md) and never alters Heart
evidence.

Public status, idle, history, and input-bound answer observation may notify
optional plugins when they establish a retained committed outcome identity.
That observation is not body consumption, acknowledgment, or an idle judgment;
its absence or failure changes no Akuma result or fact. Internal reads do not
inherit this observation responsibility. [plugins.md](plugins.md) owns delivery
and operation-local uniqueness.

History pages the same projected ledger and is the sole public execution-history
read. Page boundaries distinguish retained extent, omission and retention loss;
known completeness is never inferred from an unavailable observation. Requested
historical delivery evidence remains exact rather than reconstructed by later reads.
An exact activity read recovers the independently retained fact at that identity.
It creates no outcome, fork point, or durable fact, and never substitutes a nearby
row or another result. Provider capture and retention still bound recovery;
unretained and non-activity coordinates remain unknown.
It retains exact answered outcome bytes, including an empty answer, and
the public history identity for a retained answered Turn. Latest-answer selection
returns both from one retained observation; later non-answer facts do not replace it.
Fork accepts only an exact answered point. Pruned history remains unavailable;
observations fabricate neither cursor nor result nor loss marker.

A stream observes that same retained timeline continuously: the caller pulls
complete bounded timeline windows, one at a time, instead of asking for a page.
Each emission is the whole latest typed window, never a delta, so a consumer
reassembles nothing and owns no cursor. Its retention and loss evidence keeps
the ordinary history meaning. An initial window always emits; later windows emit only when their content
changes. Observation is pull-driven: the stream reads while its consumer pulls
and retains nothing beyond the current window and one internal reader, so a
slow consumer accumulates no backlog. Complete windows coalesce, and
coalescing is not lossless delivery — intermediate states, and rows outside
the window or pruned before observation, can be missed. The stream exposes no
cadence, cursor, transport, or lifecycle configuration. Ending the observation
— abort, an explicit return, or leaving a `for await` loop — releases its read
custody and timers, whether it is waiting for a change or suspended after an
emission. An end request never queues behind a pull that an idle timeline would
not settle: it ends that pull and releases in the same turn. A hard read
failure ends the stream with that error, and an unborn
identity fails with the existing unborn refusal. `history` remains the
paginated execution-history read, and `idle` and `wait` remain completion
observation.

## Handles And Lifecycle Evidence

Birth observation distinguishes an allocated coordinate from a confirmed child.
Only matching durable birth evidence supports a child result. An unborn stop
names the retained allocation and distinguishes a proven seal from unresolved
custody; neither is a born handle. Waiting for a prepared birth Body to settle
is a separate observation. Cancellation of that wait keeps the confirmed child
and stops before first input admission; it does not stop the Body.

Native selection or birth captures its launch hosting for the resulting handle.
Detached execution is the default; an explicit in-process choice runs future
locally launched Bodies in that calling Node runtime. This does not select an observation bound, persist in Soul, or relocate existing
execution. Shared-host lifetime and cancellation belong to
[akuma-execution.md](akuma-execution.md).

Native selection or birth may capture an immutable host diagnostic observer
for the resulting handle. This observes plugin diagnostics produced by the
handle's host, never remote Body logs. It is not routing, lifecycle authority,
or persisted state, and later mutation of caller options cannot replace it.
Diagnostic failure never changes a product result; [plugins.md](plugins.md)
owns diagnostic destinations and producer custody.

Selection over an already resolved World and identity is synchronous; every
operation that reads Heart, leash, or filesystem state is asynchronous. The
surface contains no owner, born, Turn, spawn, fork, receipt, ledger,
provider-event, or process-signaling handle.

A Tell is the admitted message. Ordinary `tell` reports the exact Turn to which
that input was submitted, distinguishing start from steering. It does not await
an answer or claim continuing execution. No pending submission or interrupt is
ordinary success. A confirmation stop or exceptional cancellation keeps known
admission and control evidence and the native cause, without exposing Body
identity or promising that pending work cannot advance.
`ask` admits a Tell under a required JSON Schema document and observes its parsed
JSON answer. Only Ask distinguishes invalid output from execution failure; a
text observer of invalid schema output sees the same failure diagnostic as the
timeline. Tell may explicitly observe the exact text answer instead of using the
ordinary confirmation window. Both answer observations distinguish answer,
failure, absence, and deadline. A deadline or caller signal stops observation
without retracting the input. Schema belongs only to ask. The first Tell of a
spawn is admitted only after clean prompt-free birth; later submission or
observation failure does not withdraw that input.

Ordinary Tell uses native live submission when available; otherwise its input
can drain in another Turn under the same Body. Failed execution
leaves unrelated admitted input pending for a later ordinary wake. Interrupt is
a flag on tell and ask: it atomically admits the Tell with a request for the
current Body to yield, then observes completion before waking a successor. If
completion is not proven, the Tell stays admitted and recoverable; cancellation
after admission stops observation only. Kill is the pure stop and launches no
successor.

`wait` observes Akuma-wide idle work until its Akuma-owned completion judgment or
a caller deadline. Running execution keeps observation open. Normally sleeping execution
completes only without pending Tell; without witnessed invocation-owned launch
failure, pending input keeps the conservative wait judgment.
Stranded, killed, hung, or untidy execution ends observation even with pending
Tell: unsubmitted input remains retained, but is not evidence of execution that
can advance it. Completion names the end of observation, not successful work;
the final status preserves the lifecycle cause, outcome, and pending input.
Standalone `idle` and plural
or CLI `wait` name this same judgment for their respective caller contexts, and
one set-observation owner serves standalone, plural, and invocation waits:
frozen caller order, any/all completion, transient unreadable peers, and honest
final observed/unobserved evidence. Each caller consumes compact native member
evidence, without an intermediate full-status collection or a private alternate
completion predicate. Wait returns stopped life, pending input, concurrent
failure, and the exact retained outcome and answer, distinguishing missing from
unreadable subjects. Lightweight probes read life and pending input without
narration. Lifecycle-only waits do not decode retained activity. When a caller
requests bounded activity, only a witnessed running member carries a compact
tail of its current Turn, never a previous settled Turn's tail or a substitute
for an exact answer. Life, outcome, and requested detail share one observation.
Activity failure remains local; final processing stays bounded and cancellable
after the deadline.
Every return says whether it completed
or reached the deadline; completion wins when the final deadline-edge observation
satisfies the judgment. A deadline
remains a current observation rather than manufacturing a lifecycle arm.
The interrupt flag and kill expose only honest settlement or
unavailability evidence. Hung, untidy, and resume-unsupported state preserve
their durable cause and available facts; the surface does not prescribe the
flagship's next action.

Input-bound answer observation shares the execution-progress judgment, but never
substitutes another input's outcome. An exact retained answer or failure wins;
a historical failed wake remains visible with its usable diagnostic and log
coordinates even when an exact Ask answer wins the invocation judgment.
Without one, stopped execution returns unanswered and retains the input. An exact
canceled Turn likewise returns unanswered immediately, even when successor work
is already running; that later work never supplies the canceled Ask's answer.
Cancellation is a retained terminal in status, history, and stream, with its own
outcome identity but no answer and no fork point. An invocation's unsettled wake
preserves its launch gap; an explicitly failed wake
ends waiting when no execution is running and retains its admission diagnostic.
Unexpected wake rejection remains an exceptional failure, not a fabricated
provider outcome. Observation neither retries nor changes Tell facts. Without
invocation-owned wake evidence, sleeping execution with pending input retains
the conservative pending-input wait rather than guessing that launch has failed.

Schema on an ask carries a provider answer contract as a JSON Schema document.
Admission canonicalizes and bounds the document before provider work. Ask parses
the exact JSON answer without caller-side transformation or schema-conformance
validation. A machine-usable shape never makes the answer true.

Lifecycle observation must not manufacture an unclean end by combining old
running evidence with a Body's later leash release. A free-seat judgment uses
fresh Heart evidence protected against succession for that bounded observation;
it neither mutates lifecycle facts nor retains execution custody afterward.

The native roster is an internal bounded recent-activity observation. Its order
is the later of each readable Heart's life and
activity evidence, with complete identity breaking equal activity and
untimestamped rows following timestamped rows. A lifecycle-selected roster uses
the Akuma owner's active or settled classification before bounding, together with
any caller selection. The observation says whether another readable matching member
lies beyond its bounded result without claiming a total or a frozen continuation.
It observes native life and activity without loading history. World composition
owns Alias and current-work enrichment. Ordinary roster observation omits the
birth recipe. Recognized
unborn or stillborn allocation state remains visible; a hard direct-read failure
may omit that roster row without suppressing readable peers and without
inventing a per-row diagnostic. Status and roster never re-evaluate provider
capability or turn provider evidence into new lifecycle facts. An explicit
advanced library observation may read the complete roster for callers whose
semantics require a frozen set; it is distinct from ordinary bounded observation
and never becomes a catalogue command.

The roster also answers one caller-scoped question inside the same World.
Given one frozen caller coordinate — an external integration or an Akuma in this
World — it returns the directly spawned Akumas and their transitively descended
Akumas. Only frozen Soul caller edges are followed; fork origin is not a caller
edge, and absent attribution is never inferred. The complete caller closure is
computed across every akumaName before a requested akumaName narrows it, then
presented in the same semantic activity order and bound. Each answer observes
frozen caller edges directly from Souls; no persistent ancestry record stands
beside Heart custody, so observation neither repairs nor writes one. An absent
Soul is unborn evidence, an unreadable Soul is uncertainty rather than absence,
and a readable downstream edge cannot bridge an unreadable one above it.
Unprovable members are omitted honestly without claiming there is nothing more,
and unborn or stillborn allocations never enter a caller-scoped set. A failed
lifecycle read is uncertainty about that row alone and never erases the already
proven Soul edge beneath its descendants. A member whose Heart is reclaimed
after its Soul proved the edge is omitted rather than reported as unborn, and
leaves the observed extent uncertain. An unreadable recognized Soul leaves
the observed extent uncertain because it could be a missing part of the selected
tree.

A caller-selected running count follows the same unbounded tree. Only proven
Soul ancestry and readable running life increment it. Sleeping or life-unreadable
ancestors still connect descendants through readable Souls; unreadable Souls
block only unproven paths. Direct Souls, never a stored record, prove membership.
Zero may include skipped entries; failed enumeration is unavailable.

## Boundary

Provider observation is defined by [akuma-provider.md](akuma-provider.md); Heart
owns durable facts and projection by [akuma-heart.md](akuma-heart.md). Package
selector and cross-product composition belong to [public-akuma.md](public-akuma.md).
CLI rendering and Kanshi consume this surface without reconstructing its law.
