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

The shipped Square observer posts finished notification cards directly to the
host delivery ledger. It owns no Square participant, notification artifact,
session attachment, or route. Existing World artifacts are unrelated custody
and are never read, migrated, rewritten, or deleted by this integration. The
host alone attaches, detaches, and deletes delivery sessions; unknown or deleted
recipients remain undeliverable. Missing attribution stays silent, and optional
integration failure never refuses a native operation.

The submitting integration edge selects an opaque host Owner as optional
initiator attribution. An explicit integration Owner wins; otherwise exactly one
native host identity supplies it, with the external host fallback used only when
no native identity exists. Ambiguous or missing host identity selects nothing.
The Claude child marker does not veto an explicit native session, because ordinary
tool subprocesses also carry it; child-only identity still selects nothing.
Generic Akuma core persists and forwards attribution unchanged and never
reconstructs a parent Owner from a producing Body's environment. Caller lineage
remains separate descriptive attribution.

Turn outcomes address the distinct frozen Owners carried by that Turn. Its
opening initiator owns the Turn, while coalesced and steered inputs add their
explicit initiators to its audience. Reports address only their exact opening
Turn initiator. Abnormal Body endings use only the latest admitted Turn of that
exact Body. No earlier Turn, birth caller, or ambient identity supplies a missing
audience. Birth remains silent. Full readable notice content remains model-facing
text, with generic presentation facts for receivers. Each recipient owns an
independent card under the stable Akuma/event identity; repeat posting is
idempotent. Reports, Turn outcomes, and Body endings have distinct identities.

Aliases are observer presentation, never identity, routing, or execution
authority. Observers prefer all current bindings without inventing a primary
alias, while preserving complete Akuma identity. Names come from the narrow
World-bound Alias observation, not a bounded roster or composite observation.
Square cards retain one consistent event-time name snapshot after alias moves;
unaddressed notices need no name observation. Alias failure is diagnostic-only
and cannot prevent an addressed notice from using complete identity.

Paseo native parent matching uses the host's persisted native session identity,
not a configured provider alias. A custom provider preserves its underlying
native identity when the host records it; absent that evidence, only its recorded
provider identity is available. Matching still requires a unique exact session
and a fresh, unchanged, unarchived parent before attachment.

Paseo mirrors instead converge to current bindings at their next ordinary
refresh or explicit title synchronization. Alias moves promise no immediate
update, signal, watcher, or retry queue. Names never change mirror creation
identity or persistent matching. Unavailable Alias authority preserves known
titles; title failures remain diagnostic-only and independent of runtime refresh
and observer resource retirement.

Within one activation, same-Body notifications serialize. A committed or
suppressed failed or canceled Turn card prevents a redundant abnormal Body card
for that recipient alone. Failed posting never claims a recipient was notified.
Cancellation fences the handler's participation, and accepted external custody
is never recalled. Ledger connections remain owned through asynchronous external
settlement even when a bounded notification attempt has returned. This creates
no retry queue, daemon, second store, or delivery guarantee.

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
remote Body logs, and cannot change public results.
Independent handles may select independent destinations. Local public
observations default to line-oriented stderr; spawn observations keep their
existing Akuma log and additionally notify an explicitly selected host.
CLI output remains owned by its process edge, and Body observations retain
their own log custody.

Activation remains process-local and is selected once per World. Activation
diagnostics belong to the producer that initiated activation; delivery
diagnostics belong to that delivery invocation. A later host destination does
not replay or inherit earlier diagnostics. A destination that throws or rejects
asynchronously cannot change product results or hold execution custody.
Diagnostics create no persistence, retry, or cross-process callback channel.

A selected plugin may own an invocation-local observation resource. The
requesting edge freezes selected Akuma identities and establishes independent
temporary ledger suppressions before observing or admitting work. Each scope
covers only that Owner's Turn outcomes for its selected Akumas; overlapping
scopes retain independent custody. Renewal extends only still-live suppressions
and reports lost custody diagnostically, never recreating an expired scope.
Completion, timeout, cancellation, decode failure, and partial or late acquisition
all release only that invocation's suppressions after stopping renewal.

A bounded spawn validates its complete native recipe before allocating one child
coordinate. Observation acquires suppression for that coordinate before the same
allocation is initialized, published, and given its first ordinary Tell. No
input-correlation substitute or public allocation hook exists. Detached and
prompt-free spawns acquire no answer resource. Wait and idle establish only final
snapshot outcomes; ask and bounded spawn establish only the exact admitted input's
outcome, before answer decoding.

Established exact Turn observation records permanent exact suppression for its
explicit observer Owner, or the observing execution's selected local Owner.
This applies before or after posting, without reading a notice or answer. No
established outcome invents a suppression. Another Owner, Turn, report, or Body
ending remains independent. Observation never waits for producer notification.
Accepted external custody cannot be recalled. Permanent retention and custody
judgment belong to the ledger, not Keiyaku.

Acquisition and cleanup remain bounded and diagnostic-only, preserving native
results and admission. Scope release may best-effort dispatch newly eligible
cards; expiry needs the next ordinary receiver or dispatch opportunity and adds
no recovery guarantee. Serving Bodies choose no requester resource or recipient
from ambient parent identity. Core adds no registry or watcher.

## Signals And Boundaries

A process emits a complete owned signal at most once for that occurrence. Its
producer awaits one bounded delivery invocation: applicable handlers begin
independently and that invocation settles after every one succeeds, fails, or
times out. No later process-finally drain or cross-signal ownership remains.
Handler failure or timeout is non-authoritative silence apart from its
diagnostic: it changes neither Heart truth, lifecycle, leash, public result, nor
later Tell semantics. Keiyaku creates no retry queue, persistence record,
compensating action, or generic event bus for plugins.

Normal Akuma birth attempts `akuma.born` after Soul is durable and its first
Body has been recorded, before supervisor or Turn work. It carries frozen
origin and caller attribution, the recorded Body identity, and any submitting
initiator and Contract association already known to that launch. Absent caller
projects unknown. Spawns and forks share this Body-owned producer; wake and succession never replay it. Sealed unborn coordinates emit
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
and bounded spawn participate; roster, board, incidental reads, and lifecycle
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

Wait and ask observe once in the process returning the concrete result that
establishes identity: wait uses its returned status frontier and ask carries
exact identity beside its private live result. Later reads never reconstruct or
replay observation. Decoding follows observation, including invalid answers;
bounded spawn observes in the submitting process after admission. These
ephemeral observations are neither Keiyaku acknowledgment facts nor
cross-operation receipts. The observing integration uses its own local
ownership; attribution grants no permission and changes no public result.

The Square observer applies exact suppression solely to the observed Owner and
retained Turn identity. Its full success notice carries the exact committed
answer; failed-Turn and abnormal-Body notices retain readable markers. Attribution
is opaque and never parsed as a participant name. Missing integration or
attribution stays silence, and failed delivery never changes outcome truth.

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
