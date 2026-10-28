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

The Square observer uses Square's artifact-owned participant custody, shared
with native harness integrations. Opening a resource captures the actual
integration execution identity; recognition reads the current seats held by that
identity, and a participant name alone never grants write authority. The optional
host discovery index is not ownership evidence. Square activity remains
World-local, and worktree disposal does not relocate it to the primary World.
The submitting integration edge owns which participant a session speaks as:
an explicit name stays authoritative, an
already-established participant of that session is reused unchanged, and a
session with no identity here derives one stable name from its own provider
session coordinate. Square remains the owner of standing, ownership, and
lifecycle, so an ambiguous identity, a name another execution holds, or an
unavailable or incompatible artifact selects nothing rather than inventing,
migrating, or taking over a participant. Recognition is read-only and never
rejoins, renames, or migrates a finished participant.

A generic integration initiator supplied by the caller outranks the Square
integration's own selection and is forwarded unchanged; Square-specific
recognition belongs to the integration adapter rather than the generic caller
decoder or the Akuma domain. Before a submitting
process sends an attributed Akuma input, the optional initiation observation
lets Square establish that initiator's callable route
in the submitting session. This is identity preparation, not evidence of
successful admission; a later refusal may leave the participant standing.
Birth observation remains produced by the child's Body at the established birth
boundary, but its Square record is authored by the shared notification identity,
not by the initiator. The record visibly distinguishes the explicit initiator,
the born Akuma, and any caller attribution while addressing no one: a birth
never wakes or interrupts the submitting session. Without an initiator it is
silent. No initiating-session ownership or wake route is borrowed by the child.
Turn outcomes and abnormal Body endings are
also not expressed by the subject Akuma: one World-local notification participant
authors every such notice for the World, so the notice no longer depends on a
worker participant that may have already stepped out. That author is a logical
integration identity with a stable session of its own, not a harness session
for the producing process: it registers no recipient wake route and borrows no
ambient session ownership. Its explicit logical execution identity joins through
Square's ordinary public boundary before each send, reusing active standing and
receiving an ordinary rejoin after it has stepped out. The artifact alone owns
that custody; Keiyaku never claims or releases Square ownership storage directly.
It never takes over a foreign claim and never marks itself done after a send.
Turn outcomes address every participant carried by the
Turn's signal, never a caller captured from the producing process. The opening
initiator remains the owner, not the entire audience. No participants produces
an unaddressed outcome rather than a fallback mention.
Local outcome observation acknowledges notices only for a current participant
held by the observing execution. An explicit name may select among that
execution's established voices but never grants another execution's authority.
A notice is recognized through the shared author or
the former per-Akuma author, and the subject Akuma's own standing is irrelevant.
The operation never computes a substitute identity, joins a participant, or
creates a route merely to acknowledge; missing standing, notice, or availability
to that observer stays silence, and another Akuma's, Turn's, birth's, or Body's
notice is never consumed. An explicitly attributed observer never acquires
another execution's identity or wake route; a name alone cannot delegate
acknowledgment authority.
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

A selected plugin may also expose an invocation-local resource for a wait. The
requesting edge freezes its selected Akuma identities, acquires each plugin's
optional resource before local or forwarded observation, and retains it through
acknowledgment of only the exact outcomes in the final returned statuses. It
closes those resources afterward, including on failure or cancellation.
Acquisition, cleanup, and any late acquisition remain bounded and
diagnostic-only; they do not change the wait result. The plugin resource owns
renewal and releases only its own custody. Serving Bodies do not acquire
requester resources, and Keiyaku adds no shared lease registry or cross-process
capability. Square's optional wait resource defers selected Turn-outcome notices
only for the requesting execution's recognized participant. It neither establishes
standing nor borrows a serving execution's identity. Other recipients and notice
kinds remain unaffected; independent waits retain independent custody. Exact
observation may acknowledge an existing notice while deferral is held, but never
records an intent for a notice not yet present. Closing releases only that
invocation's deferrals, and expiry bounds abandoned custody. An installed Square
without this optional capability leaves ordinary delivery unchanged.

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
or a timeout interval multiplied by the number of results. Forwarded wait and
ask observe once in their requesting process,
after a concrete live result establishes the exact outcome identity. The serving
executor supplies semantic evidence but does not deliver that plugin signal.
Wait uses the returned status frontier; ask carries the exact semantic identity
alongside its private live result. No later read reconstructs an earlier
observation, and expired transport or durable service evidence never replays one.
Answer-schema decoding follows observation, so an invalid answer remains an
observed committed outcome. Bounded call answer observation belongs to the
submitting process, after call admission. These are ephemeral observations, not
Keiyaku acknowledgment facts or cross-operation delivery receipts. The observing
integration uses its own actual local ownership; semantic observer attribution
grants no permission and changes no public operation result.

Square may acknowledge only already-existing outcome notices corresponding to
the observed Akuma and exact retained outcome, for that observer alone. A
successful Turn notice carries the exact committed answer, while failed-Turn and
abnormal-Body notices keep their human-readable markers. Current Turn identity
comes from structured metadata, independent of presentation prose. Historical
body-only Turn notices remain recognizable through a separate legacy path;
legacy recognition never overrides malformed or mismatched metadata.
Explicit observer attribution takes precedence over ambient participant identity and
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
