# Public API

The ESM package root exposes Keiyaku as the Contract product and native
Contract handle, Akuma as the standalone single-Akuma product, and Akumas as
the World-bound plural Akuma composition. It also exposes Settings, Plugin
types, Repo, World, and the named `nuke` operation. The `./akuma` and `./akumas`
subpaths expose the same respective products as the root; Task and Kanshi
retain their named product subpaths. Import choice changes neither product
ownership nor execution semantics and exposes no private execution or storage
mechanism. The package has no generic mixed orchestration facade or legacy
compatibility export.

## Composition Boundary

Library validates caller values, composes concrete owner capabilities, and
presents public handles and results. It owns neither durable authority nor a
transport-specific result model. Local and one-hop forwarded invocation return
the same public value; forwarding cannot recurse or establish an ambient route.
Operation inputs do not carry routing, and construction captures one immutable
execution channel.

Every public domain operation takes one readonly input object unless genuinely
inputless. Any operation that observes filesystem, SQLite, process, or Git state
is asynchronous and resolves only after its owned observation and ordered effect
complete. Pure value work and construction over resolved coordinates remain
synchronous. Callers pass ordinary JavaScript values; the owning boundary
validates them once rather than requiring callers to forge brands.

Malformed caller input and Markdown fail before repository observation.
Uninterpretable persisted authority raises `AuthorityCorruptionError`. A domain
decision that admits no fact raises a typed refusal or retry; unexpected
infrastructure failures remain ordinary exceptions. Exact input and error shapes
belong to generated declarations, leaf help, and executable specifications.

## Contract Surface

`Repo` establishes the one Git world shared by its worktrees. `Keiyaku` is the
native branded Contract handle created by binding or by selecting a complete
Contract identity within that repository; instance operations never accept a
second repository coordinate. A handle offers state and guidance reads, history,
amendment, delivery, review, abandonment, arc, audit, and reconciliation.
`Keiyaku.with()` captures one immutable execution channel and Contract-local
composition, then exposes only Contract collection operations: bind, select,
list, and observe. Its actor, worktree hooks, and branch-freshness policy stay
within Contract operations and never configure Akumas. There is no Contract
`of` alias or package-root Akuma operation on Keiyaku.

Binding accepts either caller Markdown or a fork of existing terms. It may
associate a Task through the post-admission association owned by
[settlement.md](settlement.md), but a Contract never makes Task lifecycle a
Contract fact. Markdown is decoded only at the library edge; public callers do
not receive a decoded document, direct journal writer, Git handle, placement
operation, or verification runner.

An explicit target is a caller-selected existing branch. It is canonicalized at
the boundary, never guessed from the current branch, never created by Keiyaku,
and cannot name Keiyaku-owned storage. Omitting a target is deliberately
targetless, not an implicit current branch. Gates remain opaque public words;
the package does not infer a custom gate's meaning or manufacture its producer.

Contract boards and observations are frozen read-time views of the journal and
Git state. They show the adjudicated phase, current gate and dependency state,
delivery and target/worktree observation needed by a caller, but are neither
lifecycle authority nor a second eligibility judge. A targeted observation does
not pretend to know the world-wide reverse-dependency view. Text rendering may
shorten physical Git identities only when unambiguous; product identities remain
complete.

Contract listing preserves the complete board when no limit is selected. An
explicit bound reports whether that same observation contains additional
rows. Selector resolution that requires the complete board uses a private
complete read and never resolves identity through a bounded public list.
Listing remains a read-time projection, not a lifecycle judgment.

`Delivery` exposes the captured candidate identity and a presentation diff.
The diff may be unavailable when Git can no longer supply the recorded bytes;
that absence is not a lifecycle error and the diff is never persisted, gated, or
cached as authority.

Delivery, review, and audit also offer eager observation forms alongside their
existing promise operations. Each form returns one invocation-local final
result and one optional bounded progress subscription. Starting does not depend
on subscribing; leaving that subscription only stops observation, while the
caller's explicit cancellation signal is the only cancellation request. The
stream reports confirmed admission and witnessed trailing verification,
placement, continuation, or reconciliation transitions, including explicit
observation gaps. It is not a scheduler, journal verb, durable timeline, or
second result model, and its consumer cannot change the final outcome.

## Product Boundaries

Settings are an explicit shared resource. Contract operations retain derived
values, not a live Settings observation. Gate selection accepts literal opaque
gates and named bundles together: a configured name expands its bundle, while
an unconfigured name remains a literal gate. Expansion preserves first-seen
order without duplicates and does not infer producer availability. A malformed
selected bundle or unavailable configuration is a failure, not literal fallback.
An explicit empty selection needs no bundle lookup and freezes no obligations;
omission retains the operation's default or existing terms. Later configuration
changes never rewrite admitted gates.

World construction and destructive world reset are owned by
[world.md](world.md). The package root names the reset operation `nuke`; it
accepts the explicit World confirmation and adds no reset authority to a
product handle.

The standalone Akuma product owns one Akuma's identity, execution, and public
handle. `Akumas.of(world)` captures a World and execution channel for selector,
fleet, creation, and fork operations; callers do not repeat that World on each
operation. It retains an explicit Repo only for Contract selection or Dispatch
association and never infers Repo from World or World from Repo. Archetype
definitions remain an archetype-owner listing. The independent Task product
likewise captures World and does not read or write Contract authority except
through the settlement owner.

CLI grammar, flags, help rows, and literal output are owned by the CLI chapters.
They are deliberately not copied into this package law. Mutation outcome
semantics are owned by [public-results.md](public-results.md); lifecycle legality
is owned by [lifecycle.md](lifecycle.md).

## Cancellation And Confirmed Effects

Review, delivery, and audit carry caller cancellation through their local or
parent-served execution. A signal is a request to stop further work, not proof
that publication did not occur. Once a leading act has been accepted, cancellation
preserves its receipt and identifies the unfinished stage. An unknown Git
publication is still adjudicated under independent, bounded read custody before
reporting the known outcome. Resource retirement is not skipped merely because
the execution signal has already been cancelled.
