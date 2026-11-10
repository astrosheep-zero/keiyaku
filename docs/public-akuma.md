# Public Akuma Facets

This chapter owns the World-bound `Akumas` composition for creation, addressing,
and selection operations. It composes Akuma, Alias, Dispatch, Debt, and Contract
owners without moving any of their authority into Library. `Akuma` remains the
standalone product for one resolved identity; `Debts` remains an independent
World-bound product.

## Composition

`Akumas.of(world)` captures one World at construction. Composition creates no
cached resolution, parallel writer, or background integration queue. Callers do not repeat World on operations. Repo stays an
explicit separate coordinate for Contract selector and Dispatch association;
neither coordinate is inferred from the other. Every filesystem, Alias,
Dispatch, Debt, and Heart observation is awaited before its public Promise
settles. Contract-local actor, hook, and branch-freshness configuration does
not enter this composition.

Construction captures a host choice independently of observation. Detached hosting remains the default; an explicit in-process choice
runs locally admitted Bodies in the calling Node runtime. Changing the caller's
options afterward changes nothing, and selection never relocates an already
running Body. Host choice is not persisted or inherited by forked children. Shared-host lifetime and cancellation belong to
[akuma-execution.md](akuma-execution.md).

Construction may also capture an immutable host diagnostic observer. This
capability sees only plugin diagnostics produced in that host, never remote Body
logs, and cannot change public results.
The callback itself is captured, not a mutable caller options object; it enters
neither operation inputs nor persisted facts. Independent
compositions retain independent destinations. Plugin diagnostic defaults,
producer ownership, and failure isolation belong to [plugins.md](plugins.md).

Akuma creation is owned by Akuma itself. Package composition may add a requested
Contract Dispatch and then a requested Alias move. Birth or fork is the leading,
irreversible result: a later Dispatch, Alias, or observation failure is reported
as its own integration stage and never rolls back the Akuma. A Dispatch failure
prevents the requested Alias move; an Alias failure preserves Dispatch. A
contract-free birth is complete and writes no Dispatch. Fork may carry an
existing Dispatch relation to its child but never inherits an Alias or invents a
provider fork capability. The submitting process writes its spawn wiring after
spawn admission -- including any exact first Tell -- and before it observes the
spawn outcome. Dispatch and Alias remain independent cross-product authority,
not child identity, and each keeps its own integration result. Bounded-spawn
observation starts only after native validation and child allocation, with that
exact coordinate's notification suppression established before publication and
first input. The same allocated child is published by the ordinary birth owner;
no public caller-selected identity or alternate admission path is introduced.

Caller-selected World, Contract, and execution directory are validated before
birth. World proof happens once at the outer boundary. Cwd selection is explicit
and rejects an invalid selected source rather than silently falling through;
Contract association never supplies or displaces an execution directory, so
only an explicit selection or the effective invocation directory determines
it. Exact public inputs, result fields,
and timeout defaults belong to declarations and help.

Birth and spawn also accept explicit additional writable directories. The SDK
requires nonblank existing canonical absolute directories and rejects invalid
or unsupported grants before allocating an Akuma. Omission leaves existing
behavior unchanged. The Akuma/provider owner admits these additive native
filesystem roots under the provider's sandbox and writable-directory policy.

Creation accepts optional explicit caller and initiator attribution, including
prompt-free births and forks. Either kind of caller declaration is
nonauthoritative; the SDK never infers it from ambient process environment.
Fork attribution describes the invoking edge, not the source's caller. Known
Contract association may travel as observation metadata to birth execution;
Dispatch remains solely the submitting composition's authority. Execution context
uses that known launch association before Dispatch publication, naming it as
launch intent rather than claiming publication succeeded. Later execution reads
persistent association at the composition boundary. Missing or unavailable
association never blocks standalone Akuma execution and never becomes a Contract
fact in Soul.

Creation may opt out of Keiyaku execution instructions without changing
personality, tools, or progress-report availability. Wake retains
that birth choice; fork inherits it and may additionally opt out.

Plugin activation and delivery are external observation, not an Akuma creation
or facade integration stage. Their absence or failure neither alters birth nor
creates an additional public result arm; [plugins.md](plugins.md) owns their
process-local lifetime and diagnostics. Public selection observations explicitly
participate in identified-outcome observation, while association reads and
roster expansion do not. Wait and ask deliver identified outcome observation
in the observing process from the concrete result they return. Wait uses its privately retained final native status evidence before returning
compact completion observations; ask uses private live observation evidence that
never changes the public result. Delivery precedes answer decoding. Bounded spawn
answer observation stays with the submitting observer. Composition never
rereads later state to infer the identity of an earlier observed answer. Ordinary
creation answers omit routine stage inventories and repeated input, while a later
integration or observation failure retains the born child, admitted input and
usable recovery coordinates with its native failure. That exceptional evidence
is recognized only by its producing owner and survives shared failure projection.
Public consumers can inspect that owner-confirmed evidence without changing the
native exception or acquiring an execution capability; foreign error properties
cannot claim confirmed creation or admission.

A spawn composes prompt-free birth with admission of its first ordinary Tell when one is supplied; a Tell is the admitted message. The Tell is optional and a spawn without it reports birth alone, but a clean birth is reported only when every birth stage actually succeeded: a child that became durable while a later stage failed is reported as that failure, with the child identity retained rather than a fabricated success. With an observation bound, a spawn awaits the answer to that first Tell without withdrawing it at the deadline.
Akuma execution owns that admission and wake. Library composes surrounding
Dispatch and Alias facts. A schema belongs to that same input and
its answer contract; it creates no alternate spawn path and does not
alter the existing busy refusal for schema Tells to a running Akuma.

After a successful spawn or fork has made its new Akuma durable, and outside that
birth transaction, one best-effort inactive-retention sweep may follow. It can
only retire entries that satisfy the Akuma owner's fifteen-day, stopped,
unaliased, terminal-Dispatch judgment under the Alias authority lock and the
private-state publication seat that Dispatch publication uses; it never rolls
back, changes, or replaces the reported birth or fork result. Its final Heart
revalidation preserves a pending Tell observed before removal; Tell admission
takes no shared custody with retention, so an admission immediately after that
read is a best-effort boundary, not an atomic guarantee. Only an in-flight
sweep is coalesced, so a later successful birth can sweep again. List, status,
history, wait, tell, ask, and every other observation path never run it.

## Address, Selection, And Listing

Callers may observe current Alias bindings for an explicit set of complete Akuma
identities through the World-bound composition. This narrow observation validates
and deduplicates the selection, then filters one complete Alias snapshot in its
canonical order. It neither proves Akuma existence nor reads roster, Heart,
Dispatch, Contract, or composite World observation. Missing bindings are empty;
corrupt or unavailable Alias authority remains exceptional. Alias retains sole
mapping authority and supplies the binding declaration.

The Address facet is the sole selector interpreter for Akumas. It resolves
complete Akuma identity, Alias, glob, and Contract selection from one frozen owner observation,
and refuses an ambiguous human selector. Akuma itself remains unaware of Alias,
Dispatch, Contract, glob, and repository coordinates. A resolved selector is
not resolved again downstream. A readable Alias remains an Akuma address when
optional Contract composition is unavailable; that degradation stays explicit
in the separate association context rather than concealing the core Akuma.
Address may use the explicit advanced complete library observation for this
frozen expansion; it never becomes a second public catalogue.

Contract membership inside a named selector is the complete live candidate set
the Contract resolver owns, so a bounded display catalogue never decides which
names exist or which Contract a name means, and a Contract older than any
recent aperture still collides with a same-named Alias. A failed Contract
observation refuses an otherwise-unresolved name instead of passing as an empty
Contract world, while a readable Alias still selects its Akuma through that
failure. An absent Repo coordinate is simply a World without a Contract family,
where a readable Alias selects its Akuma and an unknown name stays an unknown
Alias. Identity is decided first; display detail is requested only for the
identity it yields.

Selection composes public Akuma handles after address expansion. Plural
selection resolves and freezes identities once, then fans out the same lower
owner operations or one shared set-observation algorithm. Addressed status
projects the native life and current actionable work, adding separate read-only
Dispatch and Debt associations where available; it never intersects them into
Akuma state or re-evaluates lifecycle. Execution history preserves requested
historical content and correlation independently of current associations. Selection uses one verb per meaning on both faces: `tell` admits a Tell and returns its receipt; `ask` admits a Tell and observes the answer bound to that admission; `wait` observes existing Akuma-wide work. An ask returns one shared result with answered, failed, invalid-output, unanswered, and deadline observations. Bounds are optional and limit observation only, never admission. Schema belongs to ask, not tell. Interrupt is a flag on tell or ask: it durably admits the Tell with a request for the current Body to yield, then observes completion before waking a successor; if completion is not proven, the Tell remains admitted and recoverable. Cancellation after admission stops observation, not admission. Kill is the pure stop. Tell and ask address one Akuma directly; set selection remains for wait and kill. Standalone `idle` and plural or CLI `wait` name the same
Akuma-owned completion judgment in their respective caller contexts. Wait and
kill freeze their subject set at entry in the caller's deduplicated selection
order. An
omitted completion mode is any: the wait returns when any selected member
already satisfies, or comes to satisfy during observation, the existing
completion judgment, and an already completed member counts immediately, so
repeating the same selection can return at once. Explicit all waits for the
entire selected set. The mode changes completion criteria only; it never
changes the frozen subject set, observation retries, or the honest
distinguishing of observed and unobserved subjects. Plural wait retries
transient unreadable members during observation, but final output never
fabricates completion. Wait returns compact final completion observations in frozen
selection order and
does not expose a timeline, live activity stream, current associations or viewer
callbacks. It consumes the native completion judgment without reading Dispatch
or Debt detail; compaction never removes stopped life, pending input, concurrent
failure or unknown observation.
Akuma wait refuses Contract selectors: Contract journal change observation belongs
to the Contract product. Kill retains Contract-to-Dispatch selection.
Tell and kill return their primary evidence; ask returns its input-bound observation.

`Akumas.list` is one bounded recent-activity roster observation and preserves
the owner's membership, semantic order, and observed extent; it does not count
or reopen the whole roster. Reading it is observation only and never retires an
entry. Its optional caller selection narrows that one World's roster to the
selected caller's directly and transitively descended Akumas; the caller
closure is completed across Archetypes before any Archetype filter, activity
order, and bound, and it never aggregates Worlds or consults a user-home index.
Caller selection follows the frozen birth attribution; visible Akuma lineage
names the immediate parent independently of that selection. The lower
roster supplies that native membership, order, and extent, and World
composition attaches the current Alias bindings afterward without replacing the
semantic order or counting the board. Archetype definitions are listed by the archetype
owner. The owner's bounded definitions catalogue and the native Archetype
error that spawn admission already throws are reachable from the package root,
so a root-only caller lists the same spawnable definitions the CLI shows and
identifies that error without a private module. An archetype definition may declare `hidden: true`: a hidden definition
never appears in the archetype catalogue, but it resolves and answers spawns by
name exactly as a visible one, and hiddenness is the definition's own
catalogue visibility, never inherited through `base`. The pillars and product
compositions expose no cross-product catalogue or `ls` operation, and no public
definition loader. The invocation-level exception is owned by
[public-keiyaku.md](public-keiyaku.md): it routes to existing owner listings
without introducing another catalogue model.
