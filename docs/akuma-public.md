# Akuma Public Surface

This chapter owns the small `Akuma` root product surface and its lifecycle
evidence. Exact TypeScript shapes, field budgets, and rendering belong to
declarations, help, and executable specifications.

The public caller path is `Akuma.birth`, synchronous `Akuma.select`, then `Akuma.tell` or `Akuma.ask`. Birth submits no prompt; selection performs no read. A selected Akuma exposes its identity, status, admission-only Tell, and input-bound AskResult with optional schema decoding, along with the lifecycle-only idle, history, and kill observations.
`Akumas` owns World selection, Alias and Contract selector resolution, Dispatch
and TaskHolder association, and plural request routing around this product;
those concerns do not become single-Akuma handle methods. `Akuma` remains
independent of Repo and selector composition.

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
A born status also observes the Soul's frozen action authority, so callers can
inspect the granted extent without reconstructing it from mutable Archetype
configuration or private custody. It also reports the Akuma's frozen execution
workdir, so a caller sees where its process runs without inferring that from
Contract association. Status also projects frozen birth origin and caller
from that same Soul observation. Missing caller attribution is reported as
unknown, never persisted or inferred from later execution or lineage. Status
also names the provider identifying the execution adapter and reports the
Akuma's one current model: the selection its birth admitted until the running
Body's own native evidence replaces it, and that evidence afterwards. The
admitted selection is configured intent, not proof that a native runtime used
it. An absent model is unknown, never a configured default, a stale session
copy, or a previous attempt's answer; an explicit change whose native
replacement is unnamed returns the model to unknown.
A status snapshot shows current actionable work: the open Turn when present,
active tools, pending tells, and otherwise the latest outcome. Bounded ordinary
detail can become typed gaps, but active work and actionable tells remain
visible. Reported changes are a read-time summary of successful file-change
activity on that same frontier, grouped by path and bounded to the five most
recently changed files. Repeated edits to one path become one summary with
accumulated known diffstat and the latest event identity; omitted counts refer
to files, not events. They are never a file ledger or fact.

A live observing command may receive, beside that bounded status and only for
its still-open callback, the complete retained semantic frontier from the same
fact read and Turn projection. That transient companion preserves final forms
that a later bounded status no longer selects, including rows of a newly idle
Turn. It neither widens a status nor enters a public wait or call result.

Active tools and in-flight speech belong only to a live stream's redrawable
frame. Append-only output admits activity only after settlement; closing
accounts for every row still in flight with an explicit unknown (`?`) row.
Status and history are frozen projections, so they never assert liveness.

For an open Turn, the public timeline projector selects and retains its opening
input as current work independently of the ordinary-detail budget. Its retained
call wins; only without that call, the earliest retained settled Tell delivered
at launch for that Turn is selected. A live delivery is ordinary activity, not
an opening input. Both monitoring and receipt observations retain that one
sequence-ordered evidence row without duplicating it; no opening input is
invented when its qualifying evidence is unavailable. Consumers receive the
selected row's typed identity and do not reconstruct Turn ownership from its
content or delivery metadata.

The ordinary current-work window is the open Turn's call and provider activity
along with its retained settled delivered Tells, all in durable sequence order.
Every settled say in that current Turn is protected from the ordinary status
budget. File-change activity follows the same bounded selection as other tools;
when selected it retains its typed operation and available path and diffstat. A
settled tool row also carries the observed result text and, for every file it
reported, any observed patch content; the reported-change summary stays a
read-time aggregation of operation, path, and known diffstat alone, and never a
second copy of that content. Only the selected opening input and the existing active, pending, and
receipt-specific evidence add their own pins; a later or unrelated settled Tell
gains no global status privilege. Its omission gaps therefore describe only
that current window, never an earlier Turn or unrelated Tell.

Placement discharges reported changes at the observation composition. While the
Akuma's dispatch-associated Contract is active, a composed status surfaces them
as above; once that Contract is accepted, the same observation presents no
reported changes — the candidate they described is placed and preserved in Git.
The discharge is derived at read time from the existing Dispatch association
and the Contract's phase; it writes no fact and never alters the Heart
projection. A dropped or failed Contract, an absent or failed association, and
an unproven Contract read all keep the reported changes: unplaced work still
matters.

Public status, idle, history, and input-bound answer observation may notify
optional plugins when they establish a retained committed outcome identity.
That observation is not body consumption, acknowledgment, or an idle judgment;
its absence or failure changes no Akuma result or fact. Internal reads do not
inherit this observation responsibility. [plugins.md](plugins.md) owns delivery
and operation-local uniqueness.

History pages the same projected ledger and is the sole public execution-history
read. It retains exact answered outcome bytes, including an empty answer, and
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

Native selection or birth may capture an immutable host diagnostic observer
for the resulting handle. This observes plugin diagnostics produced by the
handle's host, never remote Body logs. It is not routing, lifecycle authority,
or persisted state, and later mutation of caller options cannot replace it.
Diagnostic failure never changes a product result; [plugins.md](plugins.md)
owns diagnostic destinations and producer custody.

Selection over an already resolved World and identity is synchronous; every
operation that reads Heart, leash, or filesystem state is asynchronous. The
surface contains no owner, born, Turn, call, fork, receipt, ledger,
provider-event, or process-signaling handle.

A Tell is the admitted message, and `tell` returns its admission receipt without awaiting an answer. `ask` admits a Tell and observes the answer to that exact admission; both faces use these same verbs and the shared AskResult. Its observation distinguishes answered, failed, invalid-output, unanswered, and deadline. The decoded answer flows through the answered arm; provider failure and schema decode failure remain distinct observations, not thrown answer failures. Observation is unbounded by default; a deadline or caller signal stops observation without retracting an admitted Tell. `wait` instead observes Akuma-wide idle work. A call composes prompt-free birth with optional first ordinary Tell admission; bounded call observation awaits that first ask without changing admission. Schema belongs to ask, not tell. Interrupt is a flag on tell and ask, preempting current work before new Tell admission; kill is the pure stop. These forms retain the same busy, routing, and recovery semantics.
Wait observes status until its Akuma-owned completion judgment — a non-running
life with no pending Tell — or a caller deadline. Standalone `idle` and plural
or CLI `wait` name this same judgment for their respective caller contexts, and
one set-observation owner serves both: frozen caller order, any/all completion,
a shared ordinary-detail budget, transient unreadable peers, and honest final
observed/unobserved evidence. The standalone face is the same algorithm
projected to one association-free identity, not an unrelated loop or an upper
facade call. An observation with no live row callbacks may use the owner's
lightweight completion probe to skip expensive running snapshots, and an
internal custom completion judge always observes fully and never uses that
probe; a live observer always observes rounds, so it cannot skip activity.
Every return still carries its final status and says whether it completed or
reached the deadline; completion wins when the final deadline-edge observation
satisfies the judgment. A deadline
remains a current observation rather than manufacturing a lifecycle arm.
The interrupt flag and kill expose only honest settlement or
unavailability evidence. Hung, untidy, and resume-unsupported state preserve
their durable cause and available facts; the surface does not prescribe the
flagship's next action.

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
view. Its order is the later of each readable Heart's life and activity evidence,
with complete identity breaking equal activity and untimestamped rows following
timestamped rows. The observation says whether another readable member lies
beyond its bounded result without claiming a total or a frozen continuation.
It exposes born identity, frozen descriptive snapshots, the World's current
alias bindings naming each member, life evidence, recent
activity and pending-tell information without loading each history. Recognized
unborn or stillborn allocation state remains visible; a hard direct-read failure
may omit that roster row without suppressing readable peers and without
inventing a per-row diagnostic. Status and roster never re-evaluate provider
capability or turn provider evidence into new lifecycle facts. An explicit
advanced library observation may read the complete roster for callers whose
semantics require a frozen set; it is distinct from ordinary bounded observation
and never becomes a catalogue command.

## Boundary

Provider observation is defined by [akuma-provider.md](akuma-provider.md); Heart
owns durable facts and projection by [akuma-heart.md](akuma-heart.md). Package
selector and cross-product composition belong to [public-akuma.md](public-akuma.md).
CLI rendering and Kanshi consume this surface without reconstructing its law.
