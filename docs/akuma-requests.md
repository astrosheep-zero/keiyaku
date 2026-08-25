# Akuma Body Requests

This chapter owns one-hop Body Request transport, service, and recovery.
Allowed-action vocabulary and admission are owned by
[akuma-allowed.md](akuma-allowed.md).

## Body Requests

A provider process lives inside one parent body's drive. If that body dies,
the provider caller is already gone or is put down by predecessor settlement.
Therefore a later body closes old requests by observation only: it never
re-executes one, and never needs an exactly-once claim.

The body creates a request transport for every provider drive, and the adapter
injects `AKUMA_REQUESTS` into that drive's command environment. Nested call,
wait, tell, kill, `contract.deliver`, `contract.review`, and mutable `task.*`
operations reroute exactly when that variable exists. There is no second public
verb or generic messaging surface.

### Transport, authority, and judge

Each drive gets an ephemeral transport directory owned by the akuma:

```text
<akuma-dir>/requests/<body-sequence>/
```

The adapter injects its absolute path; a native sandbox also grants the
directory as writable. A caller atomically writes `{ id, action, payload }` to
a fresh transport claim file and polls its matching receipt without a deadline.
The transport filename is an opaque per-attempt nonce; the caller-minted request
id inside the claim is the Heart idempotence key and is never the transport
rendezvous key. The body writes the receipt projection. The directory is
best-effort removed after the drive drains, so bytes never cross drives.

Transport creation, claim and receipt reads, temporary-file publication,
directory scans, and cleanup are awaited filesystem operations. The request
pump has an asynchronous factory because opening it creates and observes this
transport; its constructor is not a second synchronous API. Awaiting transport
does not alter the serial service law below: Heart admission precedes directory
allocation, reservation precedes spawn, and terminal Heart settlement precedes
receipt projection.

Transport bytes are not facts. Before Heart admission they are claims. A live
receipt may carry a one-time operation result that Heart does not retain;
durable terminal facts and accepted Contract fact references remain reproducible.
Missing, malformed, or discarded transport bytes therefore do not create or
erase authority. A claim that reuses a request id with different payload is
refused at the transport boundary and cannot replace the existing Heart fact.
The parent Heart's request facts are the only durable request
authority and have one writer: the Body holding its leash. Admission uses the
request id for idempotence, so at-least-once claim observation produces at most
one fact. There is no second store.

For call, the claim decoder first validates the action envelope, then selects
the stated cwd or the hosting parent Soul cwd. Only then does it decode the frozen provider and
options with the existing owners for that final cwd. The complete validated
payload enters Heart; transport never supplies a second allowed-action
judgment. A malformed payload is a malformed claim and never becomes a durable
request fact.

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

`contract.deliver` carries the selected Repo's normalized primary-worktree
coordinate, a complete ContractId, optional message, `includeDirty`, and
`materializeConflict`. The
parent Body reconstructs that Repo rather than replacing it with the parent
World, supplies the authenticated requester as actor, reads Settings scoped to
the selected Repo for Git policy and hooks, and enters the same forced-local
Library deliver executor used by ordinary delivery. A live accepted receipt
carries the complete ordinary mutation result; a live conflict or materialized
result is the same typed value as local execution. Heart stores only the Repo
coordinate, ContractId, and owner-minted delivery fact id, and never stores a
materialization result. A later pump
projects that durable accepted reference for the same request id without
replaying delivery. A normal return without that owner-minted reference, or an
executor throw or cancellation, settles Heart `voided`; the durable fact is the
only settlement authority. Forwarding never carries actor, Settings, hooks,
policy, callbacks, or an unresolved selector, and it never routes beyond the
direct parent.

When reconstructing a Repo for a forwarded Contract mutation, the parent Body
process edge maps its inherited `KEIYAKU_GIT_PATH` to `Repo.at`; the request,
Heart facts, and receipts never carry that machine-local execution coordinate.

`contract.review` is independent of `contract.deliver`. Its claim carries the
selected Repo's normalized primary-worktree coordinate, a complete ContractId,
verdict, and optional summary. The direct parent reconstructs that Repo,
supplies the authenticated requester as actor, reads Settings scoped to it for
worktree hooks, and calls the same forced-local Library review executor as
ordinary review. The live receipt preserves the complete ordinary review result,
including its attestation, workspace disclosure, placement stop, physical
effects, lag, and claim projection. An accepted request stores only the Repo
coordinate, ContractId, and owner-minted review fact id in Heart. A normal
return without that reference, or an executor throw or cancellation, settles
Heart `voided`; a later pump projects only an accepted reference and never reads
or replays Contract state.

Each advertised `task.*` mutation carries its caller-selected normalized World,
the exact public structured input or Markdown bytes, and every complete TaskId
it addresses. The parent Heart judges that exact independent action key, then
the detached Body reconstructs the selected World and enters Task's one
forced-local mutation executor. Creation (`task.add`, `task.addDocument`, and
`task.compose`) supplies the authenticated requester as Task actor; later Task
mutations carry no actor. Signals and callbacks do not cross this edge.

The live receipt is the unchanged Task result. Every normal Task return settles
the request served, including refused, retry, incomplete compose, and mixed
batch results. Heart retains only `{ action }`; it never retains World, TaskIds,
Task Markdown, document diffs, verdicts, retries, or a generic result, and the
forwarder never parses the result. A later duplicate terminal claim projects a
typed `served-reference` without executing Task again or recreating the expired
result. Executor loss before a return is voided, and recovery voids every
nonterminal Task request without reading or changing Task authority.

### Recovery and pump

After predecessor settlement and before driving a turn, a body sweeps every
nonterminal request. An admitted request without a reservation becomes
`voided`: its old caller is gone and no body was spawned. This includes every
admitted `contract.deliver` or `contract.review`; the sweep does not read
Contract state, infer an attempt from actor, time, or head, or replay either
operation. For a reserved request:

1. A missing child directory becomes `voided` with evidence.
2. A lock-free child-soul read that finds a matching origin becomes `served`;
   an origin mismatch becomes terminal `voided` evidence.
3. If the soul is absent, the body tries the child leash and re-reads. Still
   absent under the leash is sealed and becomes `voided`.
4. If the leash is held, the body polls for a soul or seal for the ordinary
   birth timeout. Born becomes `served`, sealed becomes `voided`, and timeout
   remains nonterminal for the next wake.

Soul presence is monotonic, so settlement never takes a healthy child's leash.
The sweep never spawns, replays, or reprojects live receipts: its caller is gone.

The live request pump runs concurrently with one provider drive and only inside
the body that holds the parent leash. Provider completion, stop, pause, or heart
loss closes admission: no later claim is admitted and no admitted claim begins
reservation, spawn, or owner execution. The Body keeps the leash while every
in-flight serve drains to terminal Heart settlement, then removes the
best-effort transport. A returned durable reference settles `served` with that
reference; a normal return without one and an executor throw or cancellation
settle `voided`. An admitted claim fenced before invocation is also `voided`.
Heart settlement precedes live receipt projection. A missing caller or removed
transport silently loses that projection and cannot reverse settlement or make
the Body `broke-off`; only physical Heart loss can leave a request nonterminal
for the existing recovery sweep.

The directory is the live pump's custody promise: while it exists, one serving
pump can read claims and project receipts. A pump scan, read, serve, or receipt
projection failure reaches the Body turn supervisor, which follows its existing
close path and removes the directory; admitted or reserved Heart facts remain
for the next Body's recovery sweep. A malformed claim is deleted as transport
bytes, without a receipt or Heart mutation. A request filename is not a caller
liveness receipt: a pump may already have consumed a valid duplicate claim
while Heart settlement and receipt projection remain in flight. A caller polls
for its receipt until the directory disappears, which is the existing typed
`voided` channel-closed outcome.
Requests do not enter the idle predicate.

One hop holds at every depth: each provider talks only to its own unsandboxed
body, and each child body grants a fresh drive-local transport.
