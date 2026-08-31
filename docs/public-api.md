# Public API

The ESM package root is the sole public Contract import surface. It exposes the
world/repository construction, Contract handles and operations, delivery view,
settings construction, plugin contract types, and their public errors and
values. Task, Kanshi, Akuma, and Plugin remain named product subpaths with their
own owner chapters. There is no legacy package compatibility export or generic
orchestration surface.

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

`Repo` establishes the one Git world shared by its worktrees. `Keiyaku` is a
stateless branded Contract handle created by binding or by selecting a complete
Contract identity within that repository; instance operations never accept a
second repository coordinate. A handle offers state and guidance reads, history,
amendment, delivery, review, abandonment, arc, audit, and reconciliation.
Repository-level operations bind, list, observe, and reconcile Contracts.

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

The explicit repository Contract board read is complete: callers choose it
when they need the whole board as an SDK fact. Mutable catalogue composition is
a separate bounded recent observation for presentation; it never turns a
catalogue request into an exhaustive board read or a lifecycle judgment.

`Delivery` exposes the captured candidate identity and a presentation diff.
The diff may be unavailable when Git can no longer supply the recorded bytes;
that absence is not a lifecycle error and the diff is never persisted, gated, or
cached as authority.

## Product Boundaries

Settings are an explicit shared resource. Contract operations retain derived
values, not a live Settings observation. World construction and destructive
world reset are owned by [world.md](world.md); this package surface provides the
public entry and result without adding another reset authority.

The separate Akuma product owns its own identity, execution, and public handles.
Package-root composition may connect Contract-facing capabilities to it but
cannot create a second Akuma mechanism. Similarly, the Task subpath neither
reads nor writes Contract authority except through the settlement owner.

CLI grammar, flags, help rows, and literal output are owned by the CLI chapters.
They are deliberately not copied into this package law. Mutation outcome
semantics are owned by [public-results.md](public-results.md); lifecycle legality
is owned by [lifecycle.md](lifecycle.md).
