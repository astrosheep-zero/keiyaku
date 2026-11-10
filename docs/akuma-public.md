# Akuma Public Surface

This chapter owns the small `Akuma` root product surface and its lifecycle
evidence. Exact TypeScript shapes, field budgets, and rendering belong to
declarations, help, and executable specifications.

The public caller path is `Akuma.birth`, synchronous `Akuma.select`, then `Akuma.tell` or `Akuma.ask`. Birth submits no prompt; selection performs no read. A selected Akuma exposes its identity, status, admission-only Tell, and input-bound AskResult with optional schema decoding, along with the lifecycle-only idle, history, and kill observations.
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

## One Public Timeline

Status and history derive from one retained Heart timeline in durable sequence
order. They do not join outcomes by timestamp or read a second Turn projection.
Active tool work appears where it began; once its completion is witnessed, its
single completed row appears where it finished in that same durable order.
Every tool row carries the producer's native invocation identity scoped to its
Turn, so a start and its later witnessed completion name the same work without
reconstruction from arguments, position, or retained neighbours; that identity
also survives a completion whose start is no longer retained. Elapsed time is
derived only when the retained start remains available. History
cursors, live observation, current-work selection, and reported changes consume
that one completion-ordered interpretation without replaying the earlier start.
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
A status snapshot shows current actionable work: active tools, the latest settled
narration and admitted input for open work, pending tells, and otherwise the
latest outcome. Its latest retained activity time is observation evidence for
every life state, absent when no row remains and never inferred from a Turn
opening. It omits historical event coordinates and thoughts from selected detail;
exact history retains them. Bounded ordinary detail can become typed gaps, but
active work, tool failures and actionable tells remain visible. Reported changes
are a read-time summary of successful file-change activity on that same frontier,
grouped by path. When the execution directory is available, the summary bounds
its own changes to the five most recently changed files and counts outside files
separately; an unavailable directory preserves the unpartitioned summary.
Repeated edits to one path become one summary with accumulated known diffstat;
omitted counts refer to files, not events. They are never a file ledger or fact.

A live observing command may receive, beside that bounded status and only for
its still-open callback, the complete retained semantic frontier from the same
fact read and Turn projection. That transient companion preserves final forms
that a later bounded status no longer selects, including rows of a newly idle
Turn. It neither widens a status nor enters a public wait or spawn result.

Active tools and in-flight speech belong only to a live stream's redrawable
frame. Append-only output admits activity only after settlement; closing
accounts for every row still in flight with an explicit unknown (`?`) row.
Status and history are frozen projections, so they never assert liveness.

For an open Turn, the public timeline projector retains its opening input (the
retained call, or else the earliest retained settled Tell delivered at launch)
and its latest settled say independently of the ordinary-detail budget,
alongside bounded provider activity, explicit reports, and settled delivered
Tells in durable sequence order. A settled tool row carries its observed result
text and any per-file patch content, while the reported-change summary carries
path and known diffstat alone. Omission gaps describe only that
current window. Placement discharge of reported changes for an accepted
associated Contract belongs to composite observation in [kanshi.md](kanshi.md)
and never alters the Heart projection.

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
It retains exact answered outcome bytes, including an empty answer, and
the public history identity for a retained answered Turn. When that projection
omits a final narration as its answered outcome's duplicate, the outcome also
carries the omitted narration's durable identity, so a consumer correlates the
two items without comparing their text; narration that is truncated or differs
from the answer is never named as an omitted duplicate. A fork accepts only
that exact answered point. Pruned history remains honestly unavailable; public
snapshots do not fabricate a cursor, result, or loss marker.

A stream observes that same retained timeline continuously: the caller pulls
complete bounded timeline windows, one at a time, instead of asking for a page.
Each emission is the whole latest window through the existing history
projection, never a delta, so a consumer reassembles nothing and owns no
cursor. Its retention and loss evidence keeps the ordinary history meaning. An
initial window always emits; later windows emit only when their content
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

A Tell is the admitted message, and `tell` returns its admission receipt without
awaiting an answer. The receipt identifies the resolved Akuma and admitted input
once, omitting repeated input and routine successful mechanics while retaining
actionable wake and interruption evidence. `ask` admits a Tell and observes the
answer to that exact admission; both faces use these same verbs and one native
answer judgment. A decoded undefined answer remains explicit and distinct from
both an absent answer and a null answer. Its observation distinguishes answered, failed, invalid-output, unanswered, and deadline. The decoded answer flows through the answered arm; provider failure and schema decode failure remain distinct observations, not thrown answer failures. Observation is unbounded by default; a deadline or caller signal stops observation without retracting an admitted Tell. `wait` instead observes Akuma-wide idle work. A spawn composes prompt-free birth with optional first ordinary Tell admission; bounded spawn observation awaits that first ask without changing admission. Schema belongs to ask, not tell. Interrupt is a flag on tell and ask: it atomically admits the Tell with a request for the current Body to yield, then observes completion before waking a successor. If completion is not proven, the Tell stays admitted and recoverable; cancellation after admission stops observation only. Kill is the pure stop. These forms retain the same busy and recovery semantics.
Wait observes status until its Akuma-owned completion judgment or a caller
deadline. Running execution keeps observation open. Normally sleeping execution
completes only without pending Tell, preserving ordinary successor handoff.
Stranded, killed, hung, or untidy execution ends observation even with pending
Tell: unsubmitted input remains retained, but is not evidence of execution that
can advance it. Completion names the end of observation, not successful work;
the final status preserves the lifecycle cause, outcome, and pending input.
Standalone `idle` and plural
or CLI `wait` name this same judgment for their respective caller contexts, and
one set-observation owner serves both: frozen caller order, any/all completion,
a shared ordinary-detail budget, transient unreadable peers, and honest final
observed/unobserved evidence. The standalone face is the same algorithm
projected to one association-free identity, not an unrelated loop or an upper
facade call. Wait returns compact completion observations, never a timeline, live activity
stream or current cross-product associations. They retain selected order,
stopped life, whether pending input exists, concurrent failure and the exact
settled answer or outcome coordinate, with unreadable and missing subjects
distinguished. It may use the owner's lightweight completion probe to skip
expensive running snapshots; an internal custom completion judge observes fully.
The final judgment uses the same native status evidence as an addressed read,
without repeating its complete timeline. Every return says whether it completed
or reached the deadline; completion wins when the final deadline-edge observation
satisfies the judgment. A deadline
remains a current observation rather than manufacturing a lifecycle arm.
The interrupt flag and kill expose only honest settlement or
unavailability evidence. Hung, untidy, and resume-unsupported state preserve
their durable cause and available facts; the surface does not prescribe the
flagship's next action.

Input-bound answer observation shares the execution-progress judgment, but never
substitutes another input's outcome. An exact retained answer or failure wins;
without one, stopped execution returns unanswered and retains the input. An exact
canceled Turn likewise returns unanswered immediately, even when successor work
is already running; that later work never supplies the canceled Ask's answer.
Cancellation is a retained terminal in status, history, and stream, with its own
outcome identity but no answer and no fork point. An invocation's unsettled wake
preserves its launch gap; an explicitly failed wake
ends waiting when no execution is running and retains its admission diagnostic.
Unexpected wake rejection remains an exceptional failure, not a fabricated
provider outcome. Observation neither retries nor changes Tell facts. Without
invocation-owned wake evidence, sleeping execution with pending input retains
the conservative handoff wait rather than guessing that launch has failed.

Schema on an ask carries a provider answer contract. The contract may be
the package's own schema value or any Standard Schema v1 value; a vendor value
is normalized at admission, and decoding stays a caller-side operation over the
exact answer. The contract remains inside simple JSON shape vocabulary: a
projected document that steps outside it refuses at submission, naming the
offending keyword, so a fragile or unrepresentable constraint surfaces before
provider work rather than as a mysterious answer. A caller who owns an arbitrary
JSON Schema and its decoder signs that waiver explicitly and is not subject to
the refusal. Schema construction only makes a shape machine-usable; it never
makes the answer true.

Lifecycle observation must not manufacture an unclean end by combining old
running evidence with a Body's later leash release. A free-seat judgment uses
fresh Heart evidence protected against succession for that bounded observation;
it neither mutates lifecycle facts nor retains execution custody afterward.
This is not a frozen view of subsequent activity or a barrier to future Bodies.

The roster is a compact bounded recent-activity observation, not a smaller status
view. Reading it, status, history, wait, tell, ask, or any other observation
never retires an entry. Its order is the later of each readable Heart's life and
activity evidence, with complete identity breaking equal activity and
untimestamped rows following timestamped rows. The observation says whether another readable member lies
beyond its bounded result without claiming a total or a frozen continuation.
It exposes identity, the World's current alias bindings naming each member, life
evidence, recent activity, and pending-work information without loading each
history. Frozen caller attribution remains available to the owner for exact
caller selection and retention judgments; ordinary roster observation does not
repeat the birth recipe. Recognized
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
computed across every Archetype before a requested Archetype narrows it, then
presented in the same semantic activity order and bound. Any World-local
candidate index is verified against born Souls before returning a member and
falls back to direct Soul evidence on disagreement; unprovable or deleted
members are omitted honestly without claiming there is nothing more, and unborn
or stillborn allocations never enter a caller-scoped set.

## Boundary

Provider observation is defined by [akuma-provider.md](akuma-provider.md); Heart
owns durable facts and projection by [akuma-heart.md](akuma-heart.md). Package
selector and cross-product composition belong to [public-akuma.md](public-akuma.md).
CLI rendering and Kanshi consume this surface without reconstructing its law.
