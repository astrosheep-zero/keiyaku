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

## Tell And Control

Tell admission is atomic with Soul existence, so unborn targets refuse without
leaving future input behind. Body records delivery only after provider submission
evidence and terminal receipts only from provider evidence. Tell is at-least-once
by stable identity, not exactly-once: lost unrecorded submission remains pending,
while any terminal witness settles it without rollback. Kill never discards a
Tell. A durable resume promise with no adapter resume capability refuses without
starting fresh, deleting the promise, or creating a recovery machine. There is
no public resume verb.

Interrupt asks the current Body to yield, then requires its explicit settlement
and leash proof before atomically recording the Tell and waking a successor.
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
