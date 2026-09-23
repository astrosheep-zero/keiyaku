# Public Akuma Facets

This chapter owns the World-bound `Akumas` composition for creation, addressing,
and fleet operations. It composes Akuma, Alias, Dispatch, Task, and Contract
owners without moving any of their authority into Library. `Akuma` remains the
standalone product for one resolved identity; `Tasks` remains an independent
World-bound product.

## Composition

`Akumas.of(world)` captures one World and execution channel at construction.
Ordinary calls are local; a Body Request uses one explicit direct-parent
channel. Public inputs do not select a route, forwarding never recurses, and
composition creates no cached resolution, parallel writer, or background
integration queue. Callers do not repeat World on operations. Repo stays an
explicit separate coordinate for Contract selector and Dispatch association;
neither coordinate is inferred from the other. Every filesystem, Alias,
Dispatch, Task, and Heart observation is awaited before its public Promise
settles. Contract-local actor, hook, and branch-freshness configuration does
not enter this composition.

Akuma creation is owned by Akuma itself. Package composition may add a requested
Contract Dispatch and then a requested Alias move. Birth or fork is the leading,
irreversible result: a later Dispatch, Alias, or observation failure is reported
as its own integration stage and never rolls back the Akuma. A Dispatch failure
prevents the requested Alias move; an Alias failure preserves Dispatch. A
contract-free birth is complete and writes no Dispatch. Fork may carry an
existing Dispatch relation to its child but never inherits an Alias or invents a
provider fork capability.

Caller-selected World, Contract, and execution directory are validated before
birth. World proof happens once at the outer boundary. Cwd selection is explicit
and rejects an invalid selected source rather than silently falling through;
Contract association never supplies or displaces an execution directory, so
only an explicit selection or the effective invocation directory determines
it. Allowed-action additions freeze in Soul. Exact public inputs, result fields,
and timeout defaults belong to declarations and help.

Plugin activation and delivery are external observation, not an Akuma creation
or facade integration stage. Their absence or failure neither alters birth nor
creates an additional public result arm; [plugins.md](plugins.md) owns their
process-local lifetime and diagnostics.

A call composes prompt-free birth with admission of its first ordinary Tell.
Akuma execution owns that admission and wake for both local and forwarded calls;
Library composes surrounding Dispatch and Alias facts. A forwarded child receipt
proves birth only. If its exact initial Tell receipt is absent, the call keeps
the child identity and reports partial failure without replaying admission or
requesting a separate Tell authority. A schema belongs to that same input and
its answer contract; it creates no second call workflow or route and does not
alter the existing busy refusal for schema Tells to a running Akuma.

## Address, Fleet, And Listing

The Address facet is the sole selector interpreter for Akumas. It resolves
complete Akuma identity, Alias, glob, and Contract selection from one frozen owner observation,
and refuses an ambiguous human selector. Akuma itself remains unaware of Alias,
Dispatch, Contract, glob, and repository coordinates. A resolved selector is
not resolved again downstream. A readable Alias remains an Akuma address when
optional Contract composition is unavailable; that degradation stays explicit
in the separate association context rather than concealing the core Akuma.
Address may use the explicit advanced complete library observation for this
frozen expansion; it never becomes a second public catalogue.

Fleet composes public Akuma handles after address expansion. It preserves the
raw Akuma status and mutation evidence, adding separate read-only Dispatch and
Task associations where available; it never intersects them into Akuma state or
re-evaluates lifecycle. Wait and kill freeze their subject set at entry in the
caller's deduplicated selection order. An
omitted completion mode is any: the wait returns when any selected member
already satisfies, or comes to satisfy during observation, the existing
completion judgment, and an already completed member counts immediately, so
repeating the same selection can return at once. Explicit all waits for the
entire selected set. The mode changes completion criteria only; it never
changes the frozen subject set, observation retries, or the honest
distinguishing of observed and unobserved subjects. Plural wait retries
transient unreadable members during observation, but final output never
fabricates completion. A wait reports its requested mode separately from its
completed-or-deadline return reason. Tell and kill return their primary evidence; interrupt retains its
separate post-action observation.

`Akumas.list` is one bounded recent-activity roster observation and preserves
the owner's membership, semantic order, and observed extent; it does not count
or reopen the whole fleet. Archetype definitions are listed by the archetype
owner. There is no cross-product SDK catalogue or `ls` operation. The CLI's
`ls` command adapts Contract, Akuma, archetype, and Task listing through their
respective owners, and renderers consume those adjudicated values without
performing their own owner lookup.
