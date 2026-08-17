# Akuma Body Requests

This chapter owns one-hop Body Request transport, service, and recovery.
Allowed-action vocabulary and admission are owned by
[akuma-allowed.md](akuma-allowed.md).

## Body Requests

A provider process lives inside one parent body's drive. If that body dies,
the provider caller is already gone or is put down by predecessor settlement.
Therefore a later body closes old requests by observation only: it never
re-executes one, and never needs an exactly-once claim.

Body Requests exist only for a provider whose confinement is `declared`.
The body injects `AKUMA_REQUESTS` for that drive; nested call, wait, tell, and
kill operations reroute exactly when that variable exists. An unconfined
provider receives no injection and performs the ordinary local operation.
There is no third mode, second public verb, or generic messaging surface.

### Transport, authority, and judge

Each declared drive gets an ephemeral transport directory owned by the akuma:

```text
<akuma-dir>/requests/<body-sequence>/
```

The adapter grants that directory as an additional provider writable root and
injects its absolute path. A caller atomically writes `{ id, action, payload }`
to `<request-id>.request.json` and polls `<request-id>.receipt.json` without a
deadline.
The body writes the receipt projection. The request id is a caller-minted UUID.
The directory is best-effort removed after the drive drains, so bytes never
cross drives.

Transport creation, claim and receipt reads, temporary-file publication,
directory scans, and cleanup are awaited filesystem operations. The request
pump has an asynchronous factory because opening it creates and observes this
transport; its constructor is not a second synchronous API. Awaiting transport
does not alter the serial service law below: Heart admission precedes directory
allocation, reservation precedes spawn, and terminal Heart settlement precedes
receipt projection.

Transport bytes are not facts. Before heart admission they are claims; after
settlement receipts are projections that may be reproduced from the heart.
Missing, malformed, or discarded transport bytes therefore do not create or
erase authority. The parent heart's request facts are the only durable request
authority and have one writer: the body holding its leash. Admission uses the
request id for idempotence, so at-least-once claim observation produces at most
one fact. There is no second store.

For call, the claim decoder first validates the action envelope, then selects
the stated cwd or the hosting parent Soul cwd. Only then does it decode the frozen provider and
options with the existing owners and project confinement for that final cwd.
The complete validated payload enters Heart; transport never supplies a second
confinement or allowed-action judgment. A malformed payload is a malformed
claim and never becomes a durable request fact.

The child directory and its leash remain the sole judge of child birth. The
parent heart remembers only the reserved child coordinate: where to observe,
not a claim that the child was born. The child soul records origin
`{ kind: "request", parent, requestId }`.

### Admission and service

A request carries the caller's normalized absolute world, Archetype name, body,
and optional stated cwd. Omission is preserved through transport. The serving
Body uses a stated cwd when present and otherwise its authenticated parent Soul
cwd; World root and provider process cwd are not defaults at this boundary.
The serving Body requires the request world to equal its own world. World
mismatch settles `refused`; a malformed transport claim is not admitted. The
Body never silently redirects a request.

Service is serial in Heart admission order. Heart first applies the keyed
action law; a refusal runs no operation owner. An admitted call then proceeds:

```text
parse -> select cwd -> validate recipe -> admit -> allocate directory -> reserve coordinate -> spawn child
         -> await birth -> settle served -> project receipt
```

Allocation remains the atomic directory create. A candidate that loses create
is redrawn and never reaches the request fact. Only after a successful create
does the body advance the request to `reserved`, and only then may it spawn.
The publication owner accepts this reservation as a caller-supplied durable
step between allocation and spawn; ordinary call and fork supply no such step.
It makes no cross-database atomicity claim. A failure after allocation uses the
ordinary local-publication seal and settles the request `voided`.

Call uses the following transitions:

```text
admitted -> refused { diagnostic }
admitted -> reserved { child }
reserved -> served { child }
reserved -> voided { evidence }
admitted -> voided { evidence }
```

A served receipt returns the child handle. Refused and voided receipts become
typed call errors carrying the diagnostic or evidence.

### Fleet service

Wait, tell, and kill selectors are fully expanded by the child Library before
transport. Claims contain only complete, ordered, duplicate-free AkuIds in the
authenticated channel's World; Alias, glob, Contract, Repo, Settings, and World
coordinates never cross the channel. The parent Body calls the same forced-local
Fleet executors used by ordinary Library and CLI entry points, so request service
cannot recursively forward.

Heart applies keyed permission before tell or kill runs; wait remains an unkeyed
observation. A served wait stores only a service marker, never its observation or
timeout result. A served tell stores only its target and the request id used as
TellId. A served kill stores only ordered target/evidence references; lifecycle
facts remain in each target Heart. Verb results and operation failures travel only
in the live receipt and never become permission refusals or a generic result store.

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
loss closes it immediately. Cancellation fences local admission, reservation,
spawn, and receipt projection before Body releases the leash. A claim already
durably admitted or reserved at that boundary remains nonterminal; cancellation
does not invent a terminal request or receipt. The next wake's observation
sweep settles that durable state. Request recovery and the live pump are local
orchestration, so they must always be cancelable and cannot make Body `hung`.
Requests do not enter the idle predicate.

One hop holds at every depth: each provider talks only to its own unsandboxed
body, and each child body grants a fresh drive-local transport when its own
provider is declared.
