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

The Square observer shares Square's host-wide session registry with native
harness integrations. Caller registration and outcome observation use that same
registry across execution directories; a worktree-local registry cannot stand in
for it. Square activity remains World-local, and worktree disposal does not
relocate it to the primary World. The submitting integration edge owns which
participant a session speaks as: an explicit name stays authoritative, an
already-established participant of that session is reused unchanged, and a
session with no identity here derives one stable name from its own provider
session coordinate. Square remains the owner of standing, ownership, and
lifecycle, so an ambiguous identity, a name another session holds, or an
unavailable registry selects nothing rather than inventing, migrating, or taking
over a participant. Recognition is a read of Square's own registry and never
rejoins, renames, or migrates a finished participant.

A generic integration initiator supplied by the caller outranks the Square
integration's own selection and is forwarded unchanged; Square-specific
recognition belongs to the integration adapter rather than the generic caller
decoder or the Akuma domain. Before a submitting
process sends an attributed Akuma input, the optional initiation observation
lets Square establish that initiator's callable route
in the submitting session. This is identity preparation, not evidence of
successful admission; a later refusal may leave the participant standing.
Birth observation expresses only as its explicitly carried initiator, using the
route already prepared by the submitting session. It never borrows the child
process's identity or registers the child's harness route for that initiator.
Without an initiator it is silent. Turn outcomes
address every participant carried by the Turn's signal, never a caller captured
from the producing process. The opening initiator remains the owner, not the
entire audience. No participants produces an unaddressed outcome rather than a
fallback mention.
Local outcome observation acknowledges notices for the participant the producing
session is recognized as standing, and for an explicitly named participant when
no standing binding exists. It never computes a substitute identity, joins a
participant, or creates a route merely to acknowledge, and a missing standing,
notice, or identity stays silence. An explicitly forwarded observer names its own
participant and never acquires the serving session's identity or wake route.
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
non-cooperative attempt that outlives its limit loses all authority except its
diagnostic evidence. A signal that arrives while a selected plugin is still
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

A started Akuma Turn emits `akuma.turn-started` once its start fact and Tell
bindings are durable and before provider work begins. The signal identifies the
Akuma and Turn sequence and carries the Turn's optional initiator, so a
consumer can align it with the outcome that later names the same Turn. A Turn
that later fails still has a start; a Turn whose start never commits emits
nothing. Because this occurs on the Body's critical path, a producer waits one
bounded delivery exactly as it does for that Turn's outcome, so consumers stay
fast.

Every committed terminal Akuma Turn emits `akuma.turn-outcome` after its outcome
is durable, including Turns driven by later Tells. The signal identifies the
Akuma and Turn sequence and carries the committed answered or failed outcome
and the Turn's optional owner and participant audience; it does not expose
provider or continuation custody. Plugins cannot participate in providers, generic lifecycle verbs, operation inputs, or Settlement. In
particular, plugin delivery does not make birth reversible, add a pre-Body
listener, or create rollback or cross-process continuation behavior.

Public Akuma observation emits `akuma.outcome-observed` when it establishes a
specific retained committed outcome identity, whether answered or failed. This
means knowing that result exists, not consuming its body, acknowledging it, or
judging the Akuma idle. Status, wait and idle, history, stream, ask, and bounded call
answer observation participate; roster and board reads, incidental internal
reads, and lifecycle production do not. A running Akuma may have an observed
past outcome. Missing or pruned evidence, unknown completion, and a deadline
alone establish no identity; answer decoding failure does not undo an outcome
already observed.

Each observer operation owns its delivery and suppresses repeated observations
of the same Akuma and outcome within that operation only. Status and wait
observe the outcomes their selected view establishes, never historical outcomes
read incidentally while building that view. History observes its
returned page or chosen result; stream observes the retained outcomes in its
emitted window; input-bound answer observation observes only
the exact admission's committed outcome. A wait delivers for its final status
observations without consuming answer text; completion-only
probes remain completion-only. Outcomes established together receive concurrent
bounded delivery attempts; the operation awaits them without a detached queue
or a timeout interval multiplied by the number of results. Forwarded wait and ask observe
in their serving process; their submitting process does not emit again. Bounded
call answer observation belongs to the submitting process, after call admission. These are ephemeral observations, not Keiyaku acknowledgment facts or
cross-operation delivery receipts. An observation may identify its actual
observer independently of the producing process. Forwarded wait and ask use
the requesting Body's authenticated identity, never the serving environment;
local observations may use the observer plugin's current participant identity.
This attribution grants no permission and changes no public operation result.

Square may acknowledge only already-existing outcome notices corresponding to
the observed Akuma and exact retained outcome, for that observer alone. Explicit
observer attribution takes precedence over ambient participant identity and
never borrows the producing session's ownership or route. Square owns the
acknowledgment; core owns only the semantic observation. Missing Square,
observer, standing participant, corresponding notice, or availability to that
participant is silence, not permission to create, join, take over, consume other
notices, or remember an intent. A notice arriving later remains unseen until
another ordinary observation; no retry, queue, or mapping authority is created.

Every Body that reaches a durable terminal state emits `akuma.body-ended` after
that Body fact is durable. The signal identifies the Akuma and Body sequence
and carries the terminal reason, including hung custody. It observes that Body
only; a successor may already be running when the signal is delivered, and the
signal does not redefine it as an Akuma-wide idle notification. When a Body-end
observer needs to name the latest admitted input, it may use only the owner and
participants of the latest admitted Turn belonging to that exact Body. A missing
Turn or one with no participants remains unaddressed; an earlier Turn,
process environment, and launch context are not fallback owners. Square's
interruption notice is best-effort and suppresses already-notified failed-Turn
recipients individually within one process activation, without a durable receipt
or replay guarantee.
