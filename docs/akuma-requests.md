# Akuma Body Requests

This chapter owns nested provider call transport, authority, service, and recovery.

## Body Requests

A provider process lives inside one parent body's drive. If that body dies,
the provider caller is already gone or is put down by predecessor settlement.
Therefore a later body closes old requests by observation only: it never
re-executes one, and never needs an exactly-once claim.

Body Requests exist only for a provider whose confinement is `declared`.
The body injects `AKUMA_REQUESTS` for that drive; a nested `Akuma.call()` or
`keiyaku akuma call` reroutes exactly when that variable exists. An unconfined
provider receives no injection and performs the ordinary direct call. There is
no third mode, second public verb, or generic messaging surface.

### Transport, authority, and judge

Each declared drive gets an ephemeral transport directory owned by the akuma:

```text
<akuma-dir>/requests/<body-sequence>/
```

The adapter grants that directory as an additional provider writable root and
injects its absolute path. A caller writes `<request-id>.request.json` by
temporary-file rename and polls `<request-id>.receipt.json` without a deadline.
The body writes the receipt projection. The request id is a caller-minted UUID.
The directory is best-effort removed after the drive drains, so bytes never
cross drives.

Transport bytes are not facts. Before heart admission they are claims; after
settlement receipts are projections that may be reproduced from the heart.
Missing, malformed, or discarded transport bytes therefore do not create or
erase authority. The parent heart's request facts are the only durable request
authority and have one writer: the body holding its leash. Admission uses the
request id for idempotence, so at-least-once claim observation produces at most
one fact. There is no second store.

The claim decoder validates the complete frozen recipe before Heart admission.
Its provider execution uses the same exact decoder as Archetype admission, its
options use the provider-owned option decoder, and its confinement must equal
the selected adapter's pure projection for that cwd. A malformed recipe is a
malformed claim and never becomes a durable request fact.

The child directory and its leash remain the sole judge of child birth. The
parent heart remembers only the reserved child coordinate: where to observe,
not a claim that the child was born. The child soul records origin
`{ kind: "request", parent, requestId }`.

### Admission and service

A request carries the caller's normalized absolute world, Archetype name, body,
and optional cwd. The serving body requires that world to equal its own world
and normalizes the cwd at this boundary. World mismatch settles `refused`; a
malformed transport claim is not admitted. The body never silently redirects a
request.

Service is serial in heart admission order:

```text
validate -> admit -> allocate directory -> reserve coordinate -> spawn child
         -> await birth -> settle served -> project receipt
```

Allocation remains the atomic directory create. A candidate that loses create
is redrawn and never reaches the request fact. Only after a successful create
does the body advance the request to `reserved`, and only then may it spawn.
The publication owner accepts this reservation as a caller-supplied durable
step between allocation and spawn; ordinary call and fork supply no such step.
It makes no cross-database atomicity claim. A failure after allocation uses the
ordinary local-publication seal and settles the request `voided`.

The closed transitions are:

```text
admitted -> refused { diagnostic }
admitted -> reserved { child }
reserved -> served { child }
reserved -> voided { evidence }
admitted -> voided { evidence }
```

A served receipt returns the child handle. Refused and voided receipts become
typed call errors carrying the diagnostic or evidence.

### Recovery and pump

After predecessor settlement and before driving a turn, a body sweeps every
nonterminal request. An `admitted` request without a reservation becomes
`voided`: its old caller is gone and no body was spawned. For a reserved
request:

1. A missing child directory becomes `voided` with evidence.
2. A lock-free child-soul read that finds a matching origin becomes `served`;
   an origin mismatch becomes terminal `voided` evidence.
3. If the soul is absent, the body tries the child leash and re-reads. Still
   absent under the leash is sealed and becomes `voided`.
4. If the leash is held, the body polls for a soul or seal for the ordinary
   birth timeout. Born becomes `served`, sealed becomes `voided`, and timeout
   remains nonterminal for the next wake.

Soul presence is monotonic, so settlement never takes a healthy child's leash.
The sweep never spawns, replays, or reprojects receipts: its caller is gone.

The live request pump runs concurrently with one provider drive and only inside
the body that holds the parent leash. The entrance opens when the adapter starts
with the drive's request directory. Provider completion, stop, pause, or heart
loss closes it immediately. After closing, no new claim is admitted; every
already-admitted service runs to a terminal request fact and projects its
receipt before the body persists the turn, records put-down, or follows the
heart-loss burial path. A normal body exit therefore has no nonterminal
request. A crash may leave one; the next wake's observation sweep or the death
transaction closes it.
Requests do not enter the idle predicate because live service drains within its
drive scope.

One hop holds at every depth: each provider talks only to its own unsandboxed
body, and each child body grants a fresh drive-local transport when its own
provider is declared.
