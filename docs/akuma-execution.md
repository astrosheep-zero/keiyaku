# Akuma Execution

This chapter owns Body execution and the tell, interrupt, kill, and fork
lifecycle verbs. Heart owns their durable facts; provider adapters own the live
native session and custody described by [akuma-provider.md](akuma-provider.md).

## Body, Turns, And Wake

A Body holds one leash and may drive successive Turns. It admits a Turn before
provider work and writes one terminal outcome. After a controlled stop proves
retirement of its actual provider custody, the exact owned Body's put-down and
cancellation of all its still-open Turns commit together, including Turns without
Tell bindings. Existing terminals win unchanged. Cancellation supplies neither an
answer nor a failure diagnostic; unproven execution loss leaves Turns open, while
hung custody and genuine execution or cleanup failures remain failures. A failed
cancellation cannot publish an ordinarily settled put-down. A Body uses the
persisted Soul and latest valid session recipe; Heart loss makes it
retire only provider custody it directly owns and exit.

An input may carry its submitting initiator for outcome addressing. A Turn
freezes that identity from its opening call or, without a call, its first
launch Tell. Later coalesced inputs and live steering do not replace the Turn's
single owner. A Turn's audience includes that opening identity and the
initiators of every Tell bound to it, without duplicates. Live steering and
launch routing decide how input enters the Turn, never who hears its outcome.
A subsequent Turn takes its own opening input's identity, including explicit
absence; it never inherits the birth caller or the Body environment.
This attribution does not affect execution. Host integrations submit opaque
Owners directly; generic execution retains them unchanged, independently of
descriptive caller lineage or producing environment.

An open Turn's wait retains observation work in bounded amount rather than in
proportion to elapsed control observations. Waiting on provider narration, Tell
submission, Heart observation, or a terminal or failure signal does not
accumulate retained work as control observations pass, while current Heart
snapshot semantics and responsiveness are preserved. Once the wait ends, later
notifications neither write nor restart execution. Cancellation cannot physically
detach a reaction already registered on a source that has not settled, so a
bounded residue may remain past retirement; that residue never weakens the actual
provider closure proof, and no stronger claim of physical removal is made. The
wait owner creates no custody and manufactures no provider outcome.

A Body begins with ordinary host configuration and establishes an isolated
execution identity before provider or plugin setup. Native setup may then
establish that Body's own session coordinate. A parent execution's harness
identity never attributes child work. A Body establishes its own Akuma and
World identity for deeper delegation and removes inherited external attribution.
An ordinary tool process launched for that Body receives the pair through the
private launcher's native environment forwarding unless its authored
configuration deliberately replaces the reserved variables; that replacement
is outside the guarantee and is not corrected.

Normal birth execution attempts its optional birth observation only when that
invocation created Soul and subsequently recorded its Body, before Turn work.
Wake and succession never replay it. Loss or failed preparation between durable
Soul and that point may leave no notification; birth remains true. Birth's
submitting initiator is independent of Turn ownership, including when no input
was submitted.

Process custody is a live handle, not a stored pid, process group, start token,
or reconstructed identity. Product composition selects Body hosting and supplies
its launch capability to publication, wake, and delegation. Those algorithms
never choose a host, including when a capability is missing. Hosting is captured
by the invoking composition, defaults to detached execution, and may instead run
the Body in the calling host. It is never persisted in Soul or inferred from an
observation bound. Forked children do not inherit their parent's host choice.

Body launch custody is separate from provider-attempt custody. Launch completion
is evidence only that the launch finished, never a product outcome or proof of
birth, settlement, or successor custody; Heart and the leash judge those facts.
Cancellation asks only resources owned by that launch to retire, without rollback.
Forced cancellation requests supported disposal of those same owned resources,
not termination of a shared host. Cancellation reaches preparation as well as
provider execution, without permitting later preparation to start canceled work.
Release relinquishes only the launch holder's custody: it neither kills execution nor
guarantees host survival, and never substitutes for closure proof. An explicit
in-process host scope independently retains cancellation of its exact live
launches, including preparation, after publication releases its holder. Closing
that scope is idempotent: it prevents new launches,
requests retirement of its owned work, and awaits their execution and bounded
plugin callbacks. It never stops by Akuma identity, follows a later foreign wake,
or includes detached launches. A close racing setup prevents late execution.
Closure failure and hung custody remain visible, even if execution later retires;
closure never claims that noncooperative native work physically stopped. There is
no persisted scope, registry, scheduler, or recovery promise. In-process
execution shares the caller's Node runtime, not a worker or a replacement
process. Its active Body keeps ordinary host liveness until completion, but host
exit still loses that execution without manufacturing settlement. An observation
deadline neither cancels admitted work nor migrates it to a detached host. This
is shared lifetime, not isolation from arbitrary extension code that exits or
blocks that runtime. Native process interpretation belongs to the
detached launch edge; its optional diagnostic evidence is not required of every
launch. Graceful cancellation and forced disposal both require
the current provider attempt's closure proof. If owned provider custody cannot
retire, the Body records hung evidence, ends unsuccessfully, and releases its
leash; it never sleeps holding custody or calls this an ordinary stop. No public timeout or local recovery manufactures hung.

Wake is level-triggered by pending Tell plus absence of a live Body. The leash
alone admits a successor, but a held leash is not proof that a Body services the
input: observation may briefly hold that same custody. An owned wake that loses
only to observation rechecks durable Tell and Body custody and retries within its
same invocation. Neither held custody nor a new Body proves submission.
Reboot or failed launch can leave a Tell pending for a later ordinary interaction;
no daemon guarantees recovery. Successors never reconstruct predecessor custody. They may
continue from clean history, but hung permanently refuses them and untidy
remains conservative.

The runtime a wake launches is the waking process's own executable, resolved at
use time. There is no recorded path and no re-resolution chain. When the spawn
fails with ENOENT, wake diagnoses the missing piece honestly: it checks the
executable and the frozen execution cwd separately and names the genuinely
missing side. A missing frozen directory names its path with the remedy to
kill this Akuma and spawn a fresh one (a missing directory likely means its
Contract was accepted and the worktree cleaned up, with deliverables already in
Git). A missing executable names the waking process executable with the remedy
to re-enter with a fresh CLI process and retry, or kill and spawn fresh. Both
missing names both. Non-ENOENT spawn failures pass through unchanged. Wake
never substitutes another directory for a missing frozen cwd. Diagnosis
changes no identity, session, pending Tell, history, or Soul interpretation,
and adds no daemon, watcher, or periodic repair.

Ordinary pending input never retires an active provider attempt. After a
successful Turn and proof of provider closure, the same Body takes the next
eligible pending input into another Turn under its held leash. Clean idle
settlement atomically refuses pending input or admitted control, so input racing
settlement is either drained there or remains pending for an ordinary wake.
Failed provider setup or execution strands the Body and retains unrelated
pending input. There is no automatic successor launch, terminalization of queued
input, or recovery service; a later ordinary Tell can wake retained work.

## Tell And Control

Tell admission is atomic with Soul existence, so unborn targets refuse without
leaving future input behind. Body records delivery only after provider submission
evidence and provider terminal receipts only from provider evidence. Tell is
at-least-once by stable identity, not exactly-once: lost unrecorded submission
remains pending, while any terminal witness settles it without rollback.
Historical undelivered terminal witnesses retain their meaning; queued input
never creates new ones. Native live Tell remains optional and uses the adapter's
submission and receipt evidence; without it ordinary input waits for the current
Turn to complete. Explicit interrupt is the preemption operation. Kill never
discards a Tell or launches recovery. A durable resume
promise with no adapter resume capability refuses without starting fresh, deleting
the promise, or creating a recovery machine. There is no public resume verb.

Schema remains a Tell input property and does not invent another recovery
authority. A schema Tell is answered by a Turn dedicated to that Tell; ordinary
input waits outside that Turn. Drain groups ordinary Tells only until the next
schema Tell.
A body-less publication composed before a schema Tell exits cleanly before that
Tell is admitted; it never makes the Tell contend with its own birth Body.

Interrupt atomically admits the Tell with a request for the current Body to
yield. The predecessor never receives the protected input, and normal session
completion cannot discard it. Submission already begun before admission is not
undone. Admission survives loss of the initiating caller; the next ordinary wake
can finish the handoff, with no background recovery promise or second input
store. Both paths use the same leash-held Heart settlement judgment, and Body
publication cannot cross an unsettled barrier admitted during preparation.
A crash after barrier consumption but before launch leaves ordinary pending Tell.

Ordinary Tell confirms submission of its exact input within one finite action
window after admission, including launch preparation and any requested interrupt.
Interrupt first requires non-hung settlement of the exact predecessor and
consumption of its barrier; neither a free leash nor elapsed time is proof, and
completed interruption does not prove successor submission. Known hung refuses
fresh interrupt admission. An unconfirmed action reports its stop and known
cause while leaving admitted input and control available to advance. Final
observation is bounded too. Neither a deadline nor caller cancellation creates a
lifecycle fact or retracts admission; the observer releases any launch custody
without canceling admitted work. A bounded Ask observes its own answer from
admission on its own clock, without leaving a detached interrupt wait.

Kill similarly requires explicit settlement of the exact stopped Body before it
can record a witness. A Body that is already explicitly settled without a kill
witness — a stranded life whose process is gone — needs no stop request: kill
witnesses that exact settled Body in place, receipts the kill, and later status
and roster observation present the killed life instead of stranded. A genuinely
running or asleep Body keeps its semantics: the running Body is asked to stop
and is witnessed only after settlement, the asleep Body receipts already
stopped, and only an already witnessed Body receipts already killed. Hung takes
precedence over an end; untidy, held, or changed custody cannot prove a stop.
Stop confirmation remains finite with or without a caller signal. Cancellation
or a confirmation deadline can leave a known admitted stop without a kill witness.
Stop and interrupt remain distinct controls and never authorize external signaling.
For an externally hosted persistent runtime, kill and interrupt control current
native execution while preserving the runtime for later resume. Ordinary Turn
completion only disconnects the adapter's owned client. Neither client retirement
nor Akuma settlement claims that this retained native runtime was closed.

Fork reads one exact retained answered Turn with its native fork point. It never
substitutes a nearby turn, latest session, or emulation. A provider without fork
is categorically unable to fork. Upstream success followed by failed local birth
is reported honestly without inventing a child Heart; a successful child copies
the frozen parent Soul except its new identity, fork origin, invocation's
optional caller attribution, and an explicit instruction opt-out. A fork inherits
an existing opt-out and cannot undo it. Runtime instructions are regenerated for
the child rather than inherited as personality. The source remains lineage, not
an inferred caller.

Every committed terminal Turn, including one driven by a later Tell, is followed
by an optional plugin signal carrying that Turn's sequence and outcome. That
observation is a non-authoritative side effect: it cannot alter the outcome,
delay its truth, attach a pre-Body listener, make birth reversible, or create
rollback or continuation custody.

When a Body reaches a durable terminal state, it may emit a separate optional
Body-end observation carrying that Body's sequence and terminal reason. This is
not an Akuma-wide idle event: a successor Body may begin immediately afterward.
