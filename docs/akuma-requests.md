# Akuma Body Requests

This chapter owns one-hop Body Request transport, service, and recovery.
Permission vocabulary and admission are owned by [akuma-allowed.md](akuma-allowed.md).
Verb owners alone define their payloads, results, and service evidence.

## Transport And Authority

Each provider drive receives one disposable request channel. The provider captures
that explicit direct-parent channel once; public inputs never carry routes and
the parent serves requests with forced-local composition. There is no second
public verb, generic messaging surface, or multi-hop forwarding.

Each registered command binds its operation-owned capabilities at composition before any request can be served. Per-request
execution carries only request-service facts and never transports product capabilities.

Completion kind is a static descriptor fact: a command completes either with a child reference or with opaque service evidence,
and its descriptor exposes only that kind's projection.

Transport claims and receipts are ephemeral bytes, not facts. Heart request facts
are the sole durable authority, use request identity for idempotence, and have
one writer: the parent Body holding its leash. Same identity with different
payload refuses at the transport boundary. Missing, malformed, or discarded
transport bytes neither create nor erase authority. A valid envelope for a
registered action whose owner rejects its payload is instead a diagnostic pump
failure before admission, without a receipt or Heart fact. Live results may
expire; durable terminal facts and owner-minted references remain reproducible.

The selected descriptor validates its own request and live result. Heart stores
only opaque owner service data and validates generic request integrity. Raw World
coordinates are proved by the operation owner once; neither Heart nor the wire
mints a World. A child reservation names only where to observe child birth; the
child's own leash and Soul remain the sole birth judge.

## Admission, Service, And Recovery

Service is serial in Heart admission order. The descriptor checks authenticated
frozen permission before generic admission; refusal runs no operation owner.
An admitted service call durably marks begun before owner execution; voided
proves no product effect, while unproven records an effect whose absence or
success is not proven. An admitted call reserves its child before spawn and settles served only after birth. A failed reservation or publication settles voided without claiming
cross-database atomicity. Fleet requests cross only canonical resolved Akuma
targets; Contract and Task requests invoke their same direct-parent local
executors, retaining only owner-minted terminal references rather than replayable
results or caller composition authority.

Before a successor drive, recovery observes every nonterminal request. It never
re-executes an old request: begun service requests settle to unproven without
re-execution; explicit pump close stops admission before aborting execution and
waits for truthful in-flight settlement; abandoned unreserved work voids,
while a reservation is settled only from child Soul, seal, or current leash evidence. It never spawns
a child, reads Contract or Task authority to infer an attempt, or claims
exactly-once execution.

A reserved request settles only from child Soul, Seal, or current leash evidence; a serving-path failure after reservation invokes the same adjudication recovery uses, and while evidence is incomplete the request remains reserved. No path writes a terminal state to a reserved request without that evidence.

The live pump exists only while its parent Body holds the leash. Completion,
control, or Heart loss closes admission, drains in-flight service to terminal
Heart settlement, then disposes the channel. Receipt projection follows durable
settlement; a missing caller cannot reverse it. Caller cancellation before
request publication remains cancellation. Cancellation after durable
publication, or losing the ephemeral channel before a receipt, is a
transport-only unknown outcome carrying the same logical identity for diagnosis
only; no safe-retry guarantee is implied, and it is never a claim that the
request was voided. Requests never enter the idle predicate.

An unproven service may carry an operation-owned exceptional receipt in its
live diagnostic. Transport retains it as opaque owner failure evidence, and only
the operation owner decodes its meaning. A known leading Contract admission does
not prove the whole service completed, and an exception after that admission
cannot prove the request voided. This live detail does not add replay authority:
when it is gone, recovery still reports the durable request disposition without
re-executing the service. Parent cancellation reaches the same local execution
path, including trailing placement and verification.

## Cross-owner replay review

Every Body Request review records the following facts in the owning Heart and
transport boundary terms:

- **Leading irreversible fact:** Heart admission durably records the request
  identity before any owner execution. A child request then reserves its child
  before spawn; a service request marks begun before service execution.
- **Durable replay token:** The Heart request fact keyed by request identity is
  the replay token. A reserved child identity or begun service state is part of
  that token; transport claims and receipts are never the token.
- **Token consumption point:** An admitted token is consumed when pump closure
  voids it before reservation or service begins. A child token is consumed when
  reserved becomes served or is voided from child Soul, Seal, or current-leash
  evidence. A service token is consumed when begun becomes served, voided with
  proof of no product effect, or unproven when the effect cannot be proved
  absent.
- **Crash windows:** Review covers transport loss before admission, admission
  before reservation or begun, reservation before child birth, begun during
  owner execution, and terminal Heart settlement before receipt projection.
  Recovery observes the durable fact and never re-executes an old request.
- **Cleanup requirement:** Closing a pump stops admission, drains in-flight
  work to truthful terminal Heart settlement, releases any child leash after
  adjudication, and disposes the request channel and its ephemeral claims.
  Incomplete child evidence keeps the reserved token for a later recovery.
- **Post-consumption failure:** Receipt or live-result projection can fail or
  disappear after a terminal Heart fact is stored. The durable fact and
  owner-minted reference remain the recovery boundary; no receipt failure may
  re-run the owner effect or turn a terminal request back into pending work.
