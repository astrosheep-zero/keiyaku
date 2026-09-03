# Akuma Execution

This chapter owns Body execution and the tell, interrupt, kill, and fork
lifecycle verbs. Heart owns their durable facts; provider adapters own the live
native session and custody described by [akuma-provider.md](akuma-provider.md).

## Body, Turns, And Wake

A Body holds one leash and may drive successive Turns. It admits a Turn before
provider work, writes the one terminal outcome only after provider evidence, and
leaves interrupted or lost Turns open rather than inventing a result. A Body
uses the persisted Soul and latest valid session recipe; Heart loss makes it
retire only provider custody it directly owns and exit.

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
Body log line is never the disposition; it is at most evidence of one. No path
leaves a disposition's Tell identities with neither a proven successor nor a
Heart-owned undelivered projection. Successor creation is a consequence of that
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

Interrupt asks the current Body to yield, then requires its explicit settlement
and leash proof before atomically recording the Tell and waking a successor.
The control caller does not manufacture a hung or unavailable result from
elapsed time while that settlement is in progress; it may stop waiting through
its own signal. Hung remains a Body/provider-custody fact, and a settled or hung
Body is reported through the existing structured unavailable evidence.
Kill similarly requires explicit settlement of the exact stopped Body before it
can record a witness. Hung, untidy, held, or changed custody returns the existing
unavailable evidence and never authorizes external signaling. Pause and stop are
distinct control facts.

Fork reads one exact retained answered Turn with its native fork point. It never
substitutes a nearby turn, latest session, or emulation. A provider without fork
is categorically unable to fork. Upstream success followed by failed local birth
is reported honestly without inventing a child Heart; a successful child copies
the frozen parent Soul except its new identity and fork origin.

Every committed terminal Turn, including one driven by a later Tell, is followed
by an optional plugin signal carrying that Turn's sequence and outcome. That
observation is a non-authoritative side effect: it cannot alter the outcome,
delay its truth, attach a pre-Body listener, make birth reversible, or create
rollback or continuation custody.

When a Body reaches a durable terminal state, it may emit a separate optional
Body-end observation carrying that Body's sequence and terminal reason. This is
not an Akuma-wide idle event: a successor Body may begin immediately afterward.
