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
cancellation cannot publish an ordinarily settled put-down. When provider
retirement requires a handoff, that same Heart mutation also judges control and
records the pending-input disposition before optional outcome observation. A Body
uses the persisted Soul and latest valid session recipe; Heart loss makes it
retire only provider custody it directly owns and exit.

An input may carry its submitting initiator for outcome addressing. A Turn
freezes that identity from its opening call or, without a call, its first
launch Tell. Later coalesced inputs and live steering do not replace the Turn's
single owner. A Turn's audience includes that opening identity and the
initiators of every Tell bound to it, without duplicates. Live steering and
launch routing decide how input enters the Turn, never who hears its outcome.
A subsequent Turn takes its own opening input's identity, including explicit
absence; it never inherits the birth caller or the Body environment.
This attribution grants no permission and does not affect execution.

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

A Body begins with ordinary host configuration but establishes an isolated
execution identity and request transport before provider or plugin setup.
Native setup may then establish that Body's own session coordinate; a parent
execution's harness identity or route never attributes child work. A Body
establishes its own Akuma and World identity for deeper delegation and removes
inherited external attribution. Providers retain that Body identity.

Normal birth execution attempts its optional birth observation only when that
invocation created Soul and subsequently recorded its Body, before Turn work.
Wake and succession never replay it. Loss or failed preparation between durable
Soul and that point may leave no notification; birth remains true. Birth's
submitting initiator is independent of Turn ownership, including when no input
was submitted.

Process custody is a live handle, not a stored pid, process group, start token,
or reconstructed identity. Graceful cancellation and forced disposal both require
the current provider attempt's closure proof. If owned provider custody cannot
retire, the Body records hung evidence, ends unsuccessfully, and releases its
leash; it never sleeps holding custody or calls this an ordinary stop. No public
timeout or local request recovery manufactures hung.

Wake is level-triggered by pending Tell plus absence of a live Body. It starts a
successor only through the leash and reports only durable delivery, a successor
Body, held custody, or an honest failure. Reboot or failed launch can leave a
Tell pending for a later ordinary interaction; no daemon guarantees recovery.
Successors never reconstruct predecessor custody. They may continue from clean
history, but hung permanently refuses them and untidy remains conservative.

The runtime a wake launches is the waking process's own executable, resolved at
use time. There is no recorded path and no re-resolution chain. When the spawn
fails with ENOENT, wake diagnoses the missing piece honestly: it checks the
executable and the frozen execution cwd separately and names the genuinely
missing side. A missing frozen directory names its path with the remedy to
kill this Akuma and call a fresh one (a missing directory likely means its
Contract was accepted and the worktree cleaned up, with deliverables already in
Git). A missing executable names the waking process executable with the remedy
to re-enter with a fresh CLI process and retry, or kill and call fresh. Both
missing names both. Non-ENOENT spawn failures pass through unchanged. Wake
never substitutes another directory for a missing frozen cwd. Diagnosis
changes no identity, session, pending Tell, history, or Soul interpretation,
and adds no daemon, watcher, or periodic repair.

Normal session completion is distinct from admission-failure termination. When a
Body ends a live session normally with pending Tell and no live tell channel, that
ending Body decides exactly one disposition once. Heart records that decision in
the same atomic operation as ending-Body state, capturing the exact pending-Tell
identity snapshot before leash release. There is no async window between body end,
leash release, and handoff that leaves those Tell identities without a Heart
disposition decision. A successor holds the snapshotted pending Tell only after
Heart proves that exact successor took those identities; sequence growth, spawn
resolution, Body existence alone, or an unqualified held leash is not proof. Until
that proof, those Tell identities remain pending and the disposition is not
consumed. If spawn, release, or custody proof fails, the same session-end step
records a Heart-owned undelivered terminal projection for exactly that snapshot.
Concurrent Tells admitted after the snapshot remain pending for their own wake. A
Body log line is never the disposition; it is at most evidence of one. Absent
superseding control, no path leaves a disposition's Tell identities with neither
a proven successor nor a Heart-owned undelivered projection. An admitted stop or
interrupt supersedes that automatic disposition without terminalizing its
pending input. A kill witness prevents that predecessor's delayed automatic
launch from admitting a successor; a later ordinary Tell may still wake the
retained input. Successor creation is a consequence of the exact still-authorized
disposition, never a second decision, and duplicate wake must not create two
dispositions. Admission failure remains terminal: it produces no automatic handoff
or retry. There is no generalized retry loop and no change to provider tell
capability.

## Tell And Control

Tell admission is atomic with Soul existence, so unborn targets refuse without
leaving future input behind. Body records delivery only after provider submission
evidence and provider terminal receipts only from provider evidence. Session-end
pending-Tell disposition may record a Heart undelivered terminal witness when
successor custody is not proven. Tell is at-least-once by stable identity, not
exactly-once: lost unrecorded submission remains pending, while any terminal
witness settles it without rollback. Kill never discards a Tell. A durable resume
promise with no adapter resume capability refuses without starting fresh, deleting
the promise, or creating a recovery machine. There is no public resume verb.

Schema remains a Tell input property and does not invent a second route or
recovery machine; busy, interrupt, routing, and recovery stay shared with ordinary
Tell. A schema Tell is answered by a Turn dedicated to that schema Tell. Drain
groups ordinary Tells only until the next schema Tell.
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

Admission and completion are separate evidence. A completed interruption requires
explicit non-hung settlement of the exact predecessor, not elapsed time or a free
leash alone. Failure to establish completion retains the admitted Tell identity
and its recovery boundary rather than implying non-admission. Known hung refuses
fresh admission. Cancellation before admission leaves no input or control;
after admission it stops waiting only. A bounded ask starts observing its own
Tell immediately after admission and leaves no detached completion wait when
observation ends. Hung remains a Body/provider-custody fact, never a caller's
timeout judgment.

Kill similarly requires explicit settlement of the exact stopped Body before it
can record a witness. A Body that is already explicitly settled without a kill
witness — a stranded life whose process is gone — needs no stop request: kill
witnesses that exact settled Body in place, receipts the kill, and later status
and roster observation present the killed life instead of stranded. A genuinely
running or asleep Body keeps its semantics: the running Body is asked to stop
and is witnessed only after settlement, the asleep Body receipts already
stopped, and only an already witnessed Body receipts already killed. Hung,
untidy, held, or changed custody returns the existing unavailable evidence and
never authorizes external signaling. Stop and interrupt remain distinct controls.
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
