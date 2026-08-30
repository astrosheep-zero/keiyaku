# Akuma Body Requests

This chapter owns one-hop Body Request transport, service, and recovery.
Permission vocabulary and admission are owned by [akuma-allowed.md](akuma-allowed.md).
Verb owners alone define their payloads, results, and service evidence.

## Transport And Authority

Each provider drive receives one disposable request channel. The provider captures
that explicit direct-parent channel once; public inputs never carry routes and
the parent serves requests with forced-local composition. There is no second
public verb, generic messaging surface, or multi-hop forwarding.

Transport claims and receipts are ephemeral bytes, not facts. Heart request facts
are the sole durable authority, use request identity for idempotence, and have
one writer: the parent Body holding its leash. Same identity with different
payload refuses at the transport boundary. Missing, malformed, or discarded
transport bytes neither create nor erase authority. Live results may expire;
durable terminal facts and owner-minted references remain reproducible.

The selected descriptor validates its own request and live result. Heart stores
only opaque owner service data and validates generic request integrity. Raw World
coordinates are proved by the operation owner once; neither Heart nor the wire
mints a World. A child reservation names only where to observe child birth; the
child's own leash and Soul remain the sole birth judge.

## Admission, Service, And Recovery

Service is serial in Heart admission order. The descriptor checks authenticated
frozen permission before generic admission; refusal runs no operation owner.
An admitted call reserves its child before spawn and settles served only after
birth. A failed reservation or publication settles voided without claiming
cross-database atomicity. Fleet requests cross only canonical resolved Akuma
targets; Contract and Task requests invoke their same direct-parent local
executors, retaining only owner-minted terminal references rather than replayable
results or caller composition authority.

Before a successor drive, recovery observes every nonterminal request. It never
re-executes an old request: abandoned unreserved work voids, while a reservation
is settled only from child Soul, seal, or current leash evidence. It never spawns
a child, reads Contract or Task authority to infer an attempt, or claims
exactly-once execution.

The live pump exists only while its parent Body holds the leash. Completion,
control, or Heart loss closes admission, drains in-flight service to terminal
Heart settlement, then disposes the channel. Receipt projection follows durable
settlement; a missing caller cannot reverse it. Channel failure leaves an honest
voided/retryable path through the same logical identity. Requests never enter
the idle predicate.
