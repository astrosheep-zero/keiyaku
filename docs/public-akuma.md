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
source rather than silently falling through; workspace appointment remains a
Contract workspace concern. Birth restrictions only add constraints and freeze
in Soul. Exact public inputs, result fields, and timeout defaults belong to
declarations and help.

Plugin activation and delivery are external observation, not an Akuma creation
or facade integration stage. Their absence or failure neither alters birth nor
creates an additional public result arm; [plugins.md](plugins.md) owns their
process-local lifetime and diagnostics.

## Address, Fleet, And Catalog

The Address facet is the sole selector interpreter. It resolves complete Akuma
identity, Alias, glob, and Contract selection from one frozen owner observation,
and refuses an ambiguous human selector. Akuma itself remains unaware of Alias,
Dispatch, Contract, glob, and repository coordinates. A resolved selector is
not resolved again downstream. Address may use the explicit advanced complete
library observation for this frozen expansion; it never becomes a second public
catalogue.

Fleet composes public Akuma handles after address expansion. It preserves the
raw Akuma status and mutation evidence, adding separate read-only Dispatch and
Task associations where available; it never intersects them into Akuma state or
re-evaluates lifecycle. Wait and kill freeze their subject set at entry. Plural
wait retries transient unreadable members during observation, but final output
honestly distinguishes observed and unobserved subjects without fabricating
completion. Tell and kill return their primary evidence; interrupt retains its
separate post-action observation.

The catalog invokes exactly one selected product owner. Its Akuma catalogue is
one bounded recent-activity observation and preserves the owner's membership,
semantic order, and observed extent in every presentation; it does not count or
reopen the whole fleet. It creates no aggregate, cross-product fallback,
selector API, history scan, or provider admission. CLI and renderer layers
consume these adjudicated values without performing their own owner lookup.
