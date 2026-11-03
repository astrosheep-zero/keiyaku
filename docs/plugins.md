# Plugins

This chapter owns plugin package selection, process-local activation, declared
World-path capabilities, signal delivery, and failure isolation. Plugins are
optional observers of named Keiyaku semantics; they own neither the product
facts that cause a signal nor any public result.

## Contract And Selection

Keiyaku owns the closed signal vocabulary and the stable public plugin contract.
A plugin receives a complete signal and only the semantic identities that
signal carries. The contract does not reveal whether a CLI, a detached Body, or
another process produced it, and it supplies neither a continuation channel nor
cross-process instance identity.

Settings remains the sole owner of configuration scope, shadowing, provenance,
and read failure. When the `plugins` namespace is absent, the shipped Square
observer is selected by default. A present namespace is an explicit plugin set;
its named Square entry may enable, replace, or disable that observer. Settings
never loads code. A producing process observes its World Settings once after
dependency-light help selection and keeps that selection and its activated
instances for the rest of the process. A later process may
ordinarily observe a different configuration or installed package byte. Runtime
loading neither acquires packages nor discovers optional plugins by scanning
dependencies or process directories. Apart from the shipped default Square
observer, observers are installed independently of the core package and resolve
from the caller's World. An optional observer is not a core installation
prerequisite; an explicitly selected but missing package is an activation
diagnostic, not a product failure.

Plugin identity is declared by the activated package and must agree with the
selected name. In one process it is unique and activation follows that identity's
lexicographic order. Compatibility is explicit: an unsupported plugin contract
is not adapted or partially activated.

## Activation And Capabilities

An activated plugin is trusted same-process code, not a separate operating-
system security principal. It may receive only the World coordinate,
configuration selected for it, and the named writable capabilities it declared.
Those capabilities name World-relative plugin custody. Keiyaku validates their
coordinates by spelling and physical location, refuses management custody,
traversal, aliasing, and ambiguous declarations, and creates only the validated
directories. A plugin cannot ask the host to resolve an undeclared coordinate.
This validation is a trusted coordinate grant, not an OS sandbox.

Plugin-owned paths are outside Keiyaku management custody unless an owner later
adopts them. They are not Heart facts, Git facts, Settlement facts, Contract
worktree material, or reset targets merely because a plugin uses them.

An optional mirror may need to retain a host runtime even when the host labels
its local session idle, because the mirrored execution can continue or begin
independently. A missed registration boundary may be repaired only from a fresh
observation of the exact existing execution after the host has registered the
session; this restores presentation, never execution. Closing or archiving the
host session, or deactivating the plugin, releases only the observer's own
subscription and does not stop the underlying execution. Recovery requires a
complete directory view and a fresh match of persistent identity and world; an
incomplete view or stale, archived, or changed mapping does nothing. Host archive
and read-only recovery are not one atomic operation, so a concurrent archive
race cannot be ruled out by a plugin; recovery must preserve archive state and
must never submit input or invoke execution controls.

The Square observer uses Square's artifact-owned participant custody, shared
with native harness integrations. A Square resource itself carries no identity:
each operation supplies the integration execution's own opaque owner, derived
from that execution's harness coordinate, and a participant name alone never
grants write authority. Seat selection reads only attached standing seats held
by that exact owner; a detached, finished, or foreign seat is never selected.
The optional host discovery index is not ownership evidence. Square activity
remains World-local, and worktree disposal does not relocate it to the primary
World.
The submitting integration edge owns which participant a session speaks as:
an explicit name stays authoritative, an
already-established participant of that session is reused unchanged, and a
session with no identity here derives one stable name from its own provider
session coordinate. Square remains the owner of standing, ownership, and
lifecycle, so an ambiguous owner, a name another execution holds, or an
unavailable or incompatible artifact selects nothing rather than inventing,
migrating, or taking over a participant. Selection is read-only and never
rejoins, renames, or migrates a finished participant.

A generic integration initiator supplied by the caller outranks the Square
integration's own selection and is forwarded unchanged; Square-specific seat
selection belongs to the integration adapter rather than the generic caller
decoder or the Akuma domain. Before a submitting
process sends an attributed Akuma input, the optional initiation observation
lets Square establish that initiator's callable route in the submitting session.
It reuses or reattaches that session's own standing seat, joins only an absent
one, and never revives a finished participant or takes over a foreign seat.
This is identity preparation, not evidence of
successful admission; a later refusal may leave the participant standing.
Identity preparation is silent, including new joins and reattachment. Birth
observation remains a core signal, but Square sends no birth notice: birth has
no notification audience, and an absent audience never authorizes a broadcast
or an inferred recipient. No initiating-session ownership or wake route is
borrowed by the child.
Turn outcomes, abnormal Body endings, and progress reports use direct messaging
from one shared sender label. That label is not a participant: sending neither
joins nor acquires a seat, owner, or wake route, and does not depend on the
subject Akuma's standing. Square alone owns message and recipient custody.
Turn outcomes address every participant carried by the Turn's signal, never a
caller captured from the producing process. The opening initiator remains the
owner, not the entire audience. An absent or empty audience is silent rather
than broadcast or addressed through a fallback identity.
Committed Akuma progress reports use the same sender and wake-capable delivery,
addressed only to the report's opening Turn initiator.
The notice carries the report's own content and correlation; it does not read
the latest Turn or substitute an ambient caller. A report without an initiator
is silent. Notice delivery is best effort and does not alter report truth.
Local outcome observation acknowledges notices only for a current participant
held by the observing execution. An explicit name may select among that
execution's established voices but never grants another execution's authority.
A notice is recognized by its shared sender and structured outcome identity;
the sender label and subject Akuma need no standing.
The operation never computes a substitute identity, joins a participant, or
creates a route merely to acknowledge; missing standing or availability to that
observer stays silence, and another Akuma's, Turn's, birth's, or Body's notice is
never consumed. An explicitly attributed observer never acquires
another execution's identity or wake route; a name alone cannot delegate
acknowledgment authority.
Outcome acknowledgment and wait deferral do not consume progress reports.
Addressed outcomes use Square's wake-capable delivery boundary in
the producing process; native host hooks remain recovery boundaries rather
than the first delivery attempt. Such generated data has no implicit retention
or archival promise beyond that directory's lifetime. Managed-worktree byte
protection and removal remain governed by [git.md](git.md), not by plugin
identity or a plugin-specific cleanup hook.

Activation is all-or-nothing for each plugin. The host validates a package and
its declarations, then activates it before retaining any handlers. Import,
validation, activation, or handler failure is attributed to that plugin through
the producing process's diagnostic channel, is bounded by the five-second
attempt limit, and does not prevent other selected plugins from proceeding. The
host supplies each activation and handler attempt its own cancellation signal; a
non-cooperative attempt that outlives its limit loses authority to participate in
the operation; an invocation resource returned late receives only bounded cleanup.
A signal that arrives while a selected plugin is still
activating remains eligible only when that activation settles successfully
within the signal producer's own bounded delivery; a pending activation holds
back only that plugin's handlers, and an emission it misses is dropped with a
diagnostic and is never replayed.

## Host Diagnostics

A library host may capture diagnostics through an immutable Akuma composition
capability. It observes only diagnostics produced in that host process, never
remote Body logs, and is neither transport routing nor a public result stage.
Independent handles may select independent destinations. Local public
observations default to line-oriented stderr; call observations keep their
existing Akuma log and additionally notify an explicitly selected host.
CLI output remains owned by its process edge, and serving Body observations
retain their own log custody and authenticated observer attribution.

Activation remains process-local and is selected once per World. Activation
diagnostics belong to the producer that initiated activation; delivery
diagnostics belong to that delivery invocation. A later host destination does
not replay or inherit earlier diagnostics. A destination that throws or rejects
asynchronously cannot change product results or hold execution custody.
Diagnostics create no persistence, retry, or cross-process callback channel.

A selected plugin may own an invocation-local observation resource. The
requesting edge freezes selected Akuma identities, acquires before local
admission or forwarding, and retains custody through exact observation, bounded
acknowledgment, and answer decoding. Wait and idle acknowledge only final-status
outcomes; ask and bounded call acknowledge only their exact admitted input's
outcome. A new bounded call may correlate through its existing first Tell when
acquisition precedes child identity. That correlation only defers delivery: multiple
inputs bound to one Turn still name one outcome, and correlation never
authorizes acknowledgment. Detached and prompt-free calls own no answer resource.

Resources close on completion, failure, or cancellation. Acquisition, cleanup,
and late acquisition remain bounded and diagnostic-only, preserving native
results and admission. Plugins own renewal and release only their invocation's
custody. Serving Bodies acquire no requester resources; core adds no registry,
watcher, or cross-process capability. Square defers matching Turn notices in the
producer's World for only the observing execution's attached standing seat.
Other recipients and notice kinds remain unaffected; scopes own independent
leases. Release or expiry permits unconsumed notices at the next ordinary
posting opportunity. Without an attached seat, delivery stays unchanged.

Square serializes source insertion, exact consumption, deferral, and export
ownership under World custody. Consumption or a matching lease established
before export ownership prevents that recipient's export. The exporter calls
the delivery ledger outside the World transaction. Observation waits for neither
notification nor export or ledger custody. A later acknowledgment persists
consumption but promises no recall of an already-owned export.

Deferral and acknowledgment use only the producer's World. Captured ownership,
join generation, and locally known lifecycle fence custody. Takeover, local
leave, or known detach or deletion invalidates old handles. Ledger-only lifecycle
changes become known on ordinary privileged reconciliation; sandboxed observers
neither probe that ledger nor claim synchronous host-liveness knowledge.

## Signals And Boundaries

A process emits a complete owned signal at most once for that occurrence. Its
producer awaits one bounded delivery invocation: applicable handlers begin
independently and that invocation settles after every one succeeds, fails, or
times out. No later process-finally drain or cross-signal ownership remains.
Handler failure or timeout is non-authoritative silence apart from its
diagnostic: it changes neither Heart truth, lifecycle, leash, public result, nor
later Tell semantics. Keiyaku creates no retry queue, persistence record,
compensating action, or generic event bus for plugins.

The input-submitting edge may emit `akuma.initiating` before submitting a Call
or Tell. It identifies only the initiator, carries no operation contents, and
makes no admission claim. Forwarded submissions prepare that identity before
crossing the request channel, not in the serving parent's session. This bounded
observation is optional and cannot gate input admission.

Normal Akuma birth attempts `akuma.born` after Soul is durable and its first
Body has been recorded, before supervisor or Turn work. It carries frozen
origin and caller attribution, the recorded Body identity, and any submitting
initiator and Contract association already known to that launch. Absent caller
projects unknown. Direct calls, requested calls, and forks share this Body-owned
producer; wake and succession never replay it. Sealed unborn coordinates emit
nothing. Loss or failed preparation after Soul durability but before this point
may leave zero notification. Delivery is best effort, not exactly once or proof
of provider startup, and cannot roll back birth. This deliberately replaces
`akuma.called` without an alias or dual emission; the plugin contract version
stays unchanged for this coordinated replacement.

A committed explicit progress report emits `akuma.reported` once after its Heart
admission. The signal carries that exact report's identity, content, time, and
Akuma, Body, and Turn correlation, plus only the opening Turn initiator observed
with admission. Attribution is optional signal metadata, never required report
input. A missing initiator neither refuses the report nor supplies a fallback
recipient. Delivery remains one bounded diagnostic-only attempt: no rollback,
replay queue, receipt guarantee, or change to completion and outcome observation.
Report custody belongs to Akuma, not to an observer plugin.

A started Turn emits `akuma.turn-started` after its start and Tell bindings are
durable, before provider work. It carries Akuma/Turn identity and optional
initiator, correlating with the later outcome even if that Turn fails. Without a
committed start it emits nothing. The Body awaits one bounded delivery on this
critical path.

Every committed terminal Turn emits `akuma.turn-outcome` after durability,
including later-Tell Turns. It carries Akuma/Turn identity, the answered, failed,
or canceled outcome, and optional owner and audience. Cancellation carries no
answer or failure reason. Signals expose no provider or continuation custody;
plugins neither participate in providers, lifecycle verbs, inputs, or Settlement,
nor make birth reversible, add pre-Body listeners, or create rollback or
cross-process continuations.

Public Akuma observation emits `akuma.outcome-observed` when it establishes an
exact retained answered, failed, or canceled outcome. Knowing it exists neither
consumes its body nor judges idle. Status, wait and idle, history, stream, ask,
and bounded call participate; roster, board, incidental reads, and lifecycle
production do not. Running execution may have an observed past outcome. Missing
or pruned evidence and deadlines invent no identity; decoding failure never
undoes an established observation.

Each operation owns delivery and deduplicates the same Akuma/outcome only within
that operation. Status and wait observe their selected views, never incidental
history. History observes its returned page or chosen result; stream observes
its emitted window; input-bound observation uses only its exact admission's
outcome. Wait delivers final-status observations without reading answer text;
completion probes establish no observation. Results established together receive
concurrent bounded attempts, awaited without a detached queue or multiplied
timeout.

Forwarded wait and ask observe once in the requester after a concrete live
result establishes identity. Serving executors supply semantic evidence without
emitting the requester's signal: wait uses its returned status frontier and ask
carries exact identity beside its private live result. Later reads, expired
transport, and durable service evidence never reconstruct or replay observation.
Decoding follows observation, including invalid answers; bounded call observes
in the submitting process after admission. These ephemeral observations are
neither Keiyaku acknowledgment facts nor cross-operation receipts. The observing
integration uses its own local ownership; attribution grants no permission and
changes no public result.

Square acknowledges the observed Akuma and exact retained Turn outcome for that
observer alone, including when its notice has not yet been inserted. It consumes
matching current notices and durably remembers exact consumption in the
producer's World, so a later matching notice retains its body and other
recipients while that recipient remains consumed. No notification identity or
arrival is needed. Consumption has no expiry; optional cleanup requires producer
proof that this exact source cannot be inserted or exported again. Elapsed time,
missing notice, Heart compaction, and absent ledger receipts are not that proof.
This changes neither admissibility of old unconsumed outcomes nor ordinary
activity acknowledgment, which consumes only existing selected activities.

A successful Turn notice carries the exact committed answer; failed-Turn and
abnormal-Body notices keep their readable markers. Structured Turn identity is
independent of prose and of optional input correlation. Explicit observer
attribution takes precedence over the observing execution's own seat selection
and grants no ownership or route. Missing Square, observer, standing, or
availability stays silence, without creating or taking over a participant,
consuming another result, or installing a retry queue. Core supplies only the
semantic observation; Square owns notice custody and exact consumption.

Every Body that reaches a durable terminal state emits `akuma.body-ended` after
that Body fact is durable. The signal identifies the Akuma and Body sequence
and carries the terminal reason, including hung custody. It observes that Body
only; a successor may already be running when the signal is delivered, and the
signal does not redefine it as an Akuma-wide idle notification. When a Body-end
observer needs to name the latest admitted input, it may use only the owner and
participants of the latest admitted Turn belonging to that exact Body. A missing
Turn or one with no participants remains unaddressed; an earlier Turn,
process environment, and launch context are not fallback owners. Square's
interruption notice is best-effort and suppresses already-notified failed or
canceled Turn recipients individually within one process activation, without a
durable receipt or replay guarantee.
