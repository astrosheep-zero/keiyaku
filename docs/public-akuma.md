# Public Akuma Facets

This chapter owns package-root Akuma creation, addressing, fleet composition,
and catalogs. It composes Akuma, Alias, Dispatch, Task, and Contract owners
without moving any of their authority into Library.

## Composition

The facade captures one execution channel at construction. Ordinary calls are
local; a Body Request uses one explicit direct-parent channel. Public inputs do
not select a route, forwarding never recurses, and composition creates no cached
resolution, parallel writer, or background integration queue. Every filesystem,
Alias, Dispatch, Task, and Heart observation is awaited before its public
Promise settles.

Akuma creation is owned by Akuma itself. Package composition may add a requested
Contract Dispatch and then a requested Alias move. Birth or fork is the leading,
irreversible result: a later Dispatch, Alias, or observation failure is reported
as its own integration stage and never rolls back the Akuma. A Dispatch failure
prevents the requested Alias move; an Alias failure preserves Dispatch. A
contract-free birth is complete and writes no Dispatch. Fork may carry an
existing Dispatch relation to its child but never inherits an Alias or invents a
provider fork capability.

Caller-selected World, Contract, execution directory, readonly restriction, and
allowed-action additions are validated before birth. World proof happens once at
the outer boundary. Cwd selection is explicit and rejects an invalid selected
source rather than silently falling through; Contract association never supplies
or displaces an execution directory, so only an explicit selection or the
effective invocation directory determines it. Birth restrictions only add
constraints and freeze in Soul. Exact public inputs, result fields, and timeout
defaults belong to declarations and help.

Plugin activation and delivery are external observation, not an Akuma creation
or facade integration stage. Their absence or failure neither alters birth nor
creates an additional public result arm; [plugins.md](plugins.md) owns their
process-local lifetime and diagnostics.

Schema-bearing call and tell inputs are composed through the public Akuma
surface. A schema-bearing call waits for its own prompt-free birth Body to
settle before submitting its initial Tell, whether the call is local or
forwarded. This does not relax the busy refusal for schema Tells sent to an
existing running Akuma. The schema is frozen at input admission and does not
create a second route or alter ordinary lifecycle, wait, history, or kill
behavior.

## Address, Fleet, And Catalog

The Address facet is the sole selector interpreter. It resolves complete Akuma
identity, Alias, glob, and Contract selection from one frozen owner observation,
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

The catalog invokes exactly one selected product owner. Its Akuma catalogue is
one bounded recent-activity observation and preserves the owner's membership,
semantic order, and observed extent in every presentation; it does not count or
reopen the whole fleet. It creates no aggregate, cross-product fallback,
selector API, history scan, or provider admission. CLI and renderer layers
consume these adjudicated values without performing their own owner lookup.
