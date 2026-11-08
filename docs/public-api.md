# Public API

The ESM package exposes exactly two entries: the package root and the plugin
entry. The root exposes Kei as the native Contract handle and Keis as the
Repo-bound Contract collection, Akuma as the standalone single-Akuma product, Akumas as the World-bound
plural Akuma composition, Debt as its independent product, Kanshi as composite
observation including its bounded category aperture, Settings, Plugin types,
Repo, World, and the named `nuke` operation. No other subpath, compatibility
alias, or generic mixed orchestration facade exists, and no private execution,
composition, or storage mechanism is reachable from either entry.

## Composition Boundary

Library validates caller values, composes concrete owner capabilities, and
presents public handles and results. It owns neither durable authority nor a
separate result model. Public construction stays synchronous and free of
filesystem observation.

Each crossing value has one structural declaration at its coherent domain owner.
Library composes those declarations at caller and process boundaries; trusted
owner values are not revalidated while flowing through local composition.
Structural admission grants no product capability or business judgment.

Every public domain operation takes one readonly input object unless genuinely
inputless. Any operation that observes filesystem, SQLite, process, or Git state
is asynchronous and resolves only after its owned observation and ordered effect
complete. Pure value work and construction over resolved coordinates remain
synchronous. Callers pass ordinary JavaScript values; the owning boundary
validates them once rather than requiring callers to forge brands.

Malformed caller input and Markdown fail before repository observation. Domain
non-admission is a returned refusal or retry, never an expected exception.
Exceptional failures distinguish caller mistakes, corrupt authority, uncertain
publication, cancellation before admission, and unexpected internal failures.
They retain the native cause and any known invocation evidence. Exact input and
error shapes belong to generated declarations, leaf help, and executable specifications.

## Contract Surface

`Repo` establishes the one Git world shared by its worktrees from the one
explicit worktree coordinate the caller supplies. A missing or unresolved
coordinate is caller-invalid input, never quietly replaced by an ambient
current directory. `Kei` is the native branded Contract handle created by
binding or selecting a complete identity within that repository; instance operations never accept a
second repository coordinate. A handle offers state and guidance reads, history,
amendment, explicit Verification, delivery and its read-only preview, review,
abandonment, and arc. `Keis.of(repo)` synchronously captures the Repo, an optional
already-loaded immutable Settings value, and the Contract-local actor. Its collection
operations never take another repository coordinate. They bind, select a handle,
resolve, list, observe, wait, and reconcile either the captured world or one addressed
Contract. Construction performs no I/O and validates no product namespace.
Public construction is synchronous. The CLI and Akuma execution invoke the same
native owner operations with ordinary caller inputs. Neither the Git-world coordinate
nor a Contract handle exposes a second repair door. The composition's actor,
worktree hooks, and branch-freshness policy stay within Contract operations and
never configure Akumas; hooks and freshness are read from the captured Settings
by the operation that actually consumes them. There is no package-root Akuma
operation on the Contract collection.

Binding accepts either caller Markdown or a fork of existing terms. It may
associate a Debt through the post-admission association owned by
[settlement.md](settlement.md), but a Contract never makes Debt lifecycle a
Contract fact. Markdown is decoded only at the library edge; public callers do
not receive a decoded document, direct journal writer, Git handle, placement
operation, or private verification runner.

A bind target carries exactly three caller intents, and this chapter is their
sole owner. An explicit target is either a caller-selected existing branch or an active
Contract's appointed managed worktree. A branch is canonicalized at the
boundary, never created by Keiyaku, and cannot name Keiyaku-owned storage. A
Contract destination identifies its exact appointed worktree incarnation and
starts new Markdown work at its committed head, without capturing local edits. An omitted target takes the current attached branch of
the Repo worktree coordinate the caller explicitly supplied; a committed HEAD
attached to no branch is targetless, and a HEAD that does not exist yet is
refused as such rather than reported as a missing target. A deliberately absent
target is targetless. The default branch is resolved within bind coordinate
observation, never pre-read by an adapter or taken from an ambient process
directory. Forking differs only
in what omission means: an omitted target copies the source target including
its physical incarnation, a deliberately absent target clears it, and an
explicit target overrides it. Forking retains the source start even when the
destination changes.
Gates remain opaque public words; the package does not infer a custom gate's meaning or manufacture its producer.

A Contract wait observes the addressed journals themselves, without requiring an
Akuma World or Dispatch. It captures each selected journal's head at entry and
returns when any or all selected Contracts have a later witnessed change or are
observed terminal. An already-terminal baseline satisfies the wait but is not a
new change. Missing authority is explicit, including after
baseline, and a deadline preserves witnessed progress without changing its
subjects. Cancellation retires the wait's owned observation. Each invocation
starts anew; no cursor, acknowledgement, or replay is persisted. The handle
and collection use the same native owner.

Contract boards and observations are frozen read-time views of the journal and
Git state. They show the adjudicated phase, current gate and dependency state,
delivery and target/worktree observation needed by a caller, but are neither
lifecycle authority nor a second eligibility judge. A targeted observation does
not pretend to know the world-wide reverse-dependency view. Text rendering may
shorten physical Git identities only when unambiguous; product identities remain
complete.

Contract listing preserves the complete board when no limit is selected. An
explicit bound reports whether that same observation contains additional
rows. Contract selector resolution is a read-only, invocation-scoped capability. A
complete identity is validated without consulting repository authority or proving
existence; the requested operation owns absence. Short selectors use exact
short-name equality among active Contracts with a managed, appointed worktree.
Omitted selection matches the exact canonical worktree coordinate among those
same candidates, never an ancestor or inferred namespace. The caller supplies an
absolute directory coordinate or uses the explicit Repo's pinned worktree
coordinate; resolution never consults ambient process state.

Short and contextual resolution freezes one complete live board, never a bounded
catalogue. Invalid, redundant, unknown, ambiguous, and unmatched contextual
selectors return operation-owned refusal evidence. Malformed caller values or
invalid coordinates are caller-input errors, while corrupt or unavailable
authority remains exceptional with its native cause. Resolution neither creates
a handle nor reserves selection for a later mutation, which retains its own
admission judgment. The mixed Address facet shares only pure Contract candidate
matching; its cross-family ambiguity and Alias observation judgment stay its own.
The listing is the live board: terminal Contracts leave it, and their record
stays in the journal and Git.
Listing remains a read-time projection, not a lifecycle judgment.

Explicit verify is a native Contract operation selecting all current
declarations or one by its current one-based position. Selection is only an
invocation convenience, never persisted evidence identity. It captures the
appointed worktree under delivery's clean-worktree and explicit dirty-capture
rules and prepares the exact prospective integration without admitting a
candidate, delivery, review, or reintegration. Preparation conflict is typed
non-admission, not conflict handoff. It always executes the selected work,
admits each terminal check independently, then requests ordinary completion
using current generic requirement evidence. Only an already-delivered Contract
can place. Verification records each selected check independently of review and
delivery; generic completion judges the current evidence for every requirement.

Delivery preview observes a prospective candidate through a dedicated native handle
operation, separate from delivery admission. CLI and other adapters consume that
same typed result. It never runs Verification, reconciles, settles, or continues
dependents. It executes through the same local owner.
The observation is not a reservation: delivery observes again.

`Delivery` exposes the captured candidate identity and a presentation diff.
The diff may be unavailable when Git can no longer supply the recorded bytes;
that absence is not a lifecycle error and the diff is never persisted, gated, or
cached as authority.

Native Contract and delivery abilities keep process custody private while their
JSON projection retains public result data.

Delivery, review, verify, and delivery preview each expose one promised answer
and an optional observation callback. Execution never depends on observation; a callback cannot
hold custody, cancel execution, or change finality, even when it throws or
rejects asynchronously. Caller cancellation alone requests a stop. Observations
name confirmed admission and witnessed trailing work without becoming a
scheduler, durable timeline, or second result model.

Legitimately absent Contract reads return absence. A missing requested entry in
a supposedly complete observation remains a broken observation, and corrupt
persisted authority remains exceptional. Forking distinguishes legally unavailable
source terms from corrupt source authority rather than disguising corruption as
an ordinary refusal.

## Product Boundaries

Settings are an explicit shared resource captured once at Contract
construction. Contract operations retain derived values, not a live Settings
observation, and read a namespace only at the operation that consumes it.
Omitted Settings selects no bind gates by default, accepts only built-in gate
names, keeps hooks empty, and leaves branch freshness false. Supplied Settings
selects product behavior: omitted bind gates use the configured default bundle
or the built-in review obligation when no default exists. Explicit selections
accept built-in names and configured bundles with first-seen deduplication;
unknown names fail as caller-invalid input before admission, with the built-in
and configured selection names exposed in the diagnostic. This discovery does
not validate unselected configuration. Custom obligations
must come from an explicitly configured bundle. Expansion does not infer
producer availability. An explicit empty selection needs no bundle
lookup and freezes no obligations; omitted amendment retains the admitted gates
without lookup, and a fork copies the source gates without expansion. A
malformed selected bundle or unavailable selected namespace fails the consuming
operation as caller-invalid input retaining the native Settings error, before
any admission, rather than falling back or refusing partially. Later
configuration changes never rewrite admitted gates. Bind, amend, and fork derive
the effective requirements from the selected gates and current document;
unchanged gate selection does not freeze requirements from an older document.

World construction and destructive world reset are owned by
[world.md](world.md). The package root names the reset operation `nuke`; it
accepts the explicit World confirmation and adds no reset authority to a
product handle.

The standalone Akuma product owns one Akuma's identity, execution, and public
handle. `Akumas.of(world)` captures a World for selector, selection, creation, and fork
operations; callers do not repeat that World on each
operation. It retains an explicit Repo only for Contract selection or Dispatch
association and never infers Repo from World or World from Repo. Archetype
definitions remain an archetype-owner listing, reachable through the root as
that owner's bounded catalogue and its native error; no public definition
loader joins the root. The independent Debt product
likewise captures World and does not read or write Contract authority except
through the settlement owner. Its collection offers creation, bounded list,
readiness, blocked and query views, diagnosis, and terminal batches. Addressed
Debt handles offer reads, relationship trees, updates, completion, and dropping.
Board observation remains read-only. There is no planning or execution-progress
operation; [debt.md](debt.md) owns the three-state ledger and its dependencies.

CLI grammar, flags, help rows, and literal output are owned by the CLI chapters.
They are deliberately not copied into this package law. Mutation outcome
semantics are owned by [public-results.md](public-results.md); lifecycle legality
is owned by [lifecycle.md](lifecycle.md).

## Cancellation And Confirmed Effects

Review, delivery, verify, and delivery preview carry caller cancellation through
execution. A signal is a request to stop further work, not proof
that publication did not occur. Once a leading act has been accepted, cancellation
preserves its receipt and identifies the unfinished stage. An unknown Git
publication is still adjudicated under independent, bounded read custody before
reporting the known outcome. Resource retirement is not skipped merely because
the execution signal has already been cancelled.
