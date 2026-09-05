# Git

Git owns the physical world that carries Contract journals, candidate bytes,
target refs, managed worktrees, and Keiyaku-owned reachability. The journal is
the lifecycle authority; Git is the custody authority for the bytes it names.
Agents own their working content. Git's private topology is not a public
identity, an additional state store, or a source of Contract legality.

## World, Reads, And Publication

One repository and its linked worktrees share one Git world and one private
authority root. A Contract journal identity is independent of unrelated Git
movement. Git resolves the repository and executable once at its outer boundary;
callers cannot replace either through ambient configuration. Filesystem and Git
tree coordinates remain distinct domains.

Every product read receives one call-scoped, frozen Git observation. Product
owners select and decode only their own data; Git supplies object custody but
does not interpret product codecs. Targeted reads remain proportional to the
requested authority, while only a deliberate world read enumerates the whole
world. Observations and object reuse end with the call: there is no cross-call
cache, second index, or independently updated current-state snapshot.

Cooperating private-state writers share one repository-local publication seat.
It coordinates writers but does not decide acceptance: atomic compare-and-swap
and exact durable read-back remain the only currentness and unknown-outcome
judges. Target placement and workspace appointment keep their own outer custody
boundaries. Waiting to acquire the seat has a default bound and never a held
deadline; a timed-out wait is typed contention, not a broken lock. The seat is
not reentrant: same-context reacquisition is an invariant failure, not a wait.
The seat creates no queue, fairness promise, daemon, extra retry
budget, per-Contract ref, or lock-derived success, and cannot protect against
uncooperating external writers.

Git admission publishes a complete decision offer atomically. Opaque companion
updates may accompany a journal admission, but Git neither decodes them nor
knows their product meaning. A partial publication is corruption. When an
outcome is uncertain, only durable read-back can prove the intended admission;
Git never rebuilds or replays an old offer, parses Git prose, or silently adopts
newer terms or targets. Coordinate movement demands a fresh semantic attempt;
an unchanged rejected publication is a typed failure.

Confirmed Git reset removes state authority before regenerable topology. It is
local to Git custody, leaves foreign data alone, and provides no backup, trash,
undo, world-wide lock, or reset ledger. A failed reset can retain independently
completed effects and is retried under the World-owned confirmation rule.

## Delivery And Placement

Git prepares tenders, target-specific integration commits, content identity from
patch-id (not a commit), recorded delivery diffs, and disposable Verification
scratch custody.
It returns mechanical data or typed failures; it does not judge Contract
lifecycle or decode Contract documents. Document bytes used for delivery are
opaque Git inputs, and Git never judges their currentness.

Delivery normally requires a clean managed worktree. Explicit dirty delivery
captures the complete non-ignored final tree without rewriting the caller's
checkout; it does not authorize dirty submodule internals. When conflict
materialization is explicitly requested with that authorization, it preserves
the captured bytes as the handoff base before projecting the judged conflict.
Review can observe
ordinary dirty work without gaining delivery authority. The candidate's
worktree-content identity changes only with the captured content, not target
movement, reintegration, or diff presentation. A judged conflict changes no
authority unless the caller explicitly asks Git to project that conflict into
the appointed workspace; that projection chooses no resolution and is not a
second conflict judgment.

Conflict materialization has separate private Git custody. Keiyaku records its
receipt before projecting the merge, and only a live operation that presents
the matching unretired receipt is Keiyaku-owned. Equivalent parents, trees,
index entries, and worktree bytes never establish ownership. The receipt binds
the materialization to its Contract appointment and live workspace identity;
its carrier and field layout remain private Git mechanics. An unmatched record
with no live operation is disposable custody, while a live operation without a
matching receipt remains foreign.

Targeted placement is serialized per target and claims only when its persisted predecessor still matches. Followability is a no-effects judgment: incompatible checkouts or operational failure leave claim and target untouched; recovery belongs to [git-reconciliation.md](git-reconciliation.md). Refusals preserve the first actual physical category: staged, dirty-tracked, unmerged, or untracked; `conflict` is integration-only. Target lag names the appointed worktree against the frozen target. ContractHead and journal blob custody identifiers remain private to ordinary text.

## Custody And Cleanup

Journal facts retain candidate identities, but are not reachability edges. Git
keeps the tender and integration reachable while a managed worktree or pending
placement needs them, and a claimed target may become a custodian. Refs are
released only after an independent surviving custodian proves the required exact
commit or tender bytes remain available. Equal content never substitutes for
the integration identity. Cleanup never rewrites a target; a target rewrite or
deletion that loses custody retains the owned ref for later observation.

Workspace appointment is owned by [workspace.md](workspace.md). Git consumes an
explicit appointment and never derives, scans, adopts, or persists a worktree
coordinate from Contract identity. Its cleanliness and target-lag observations
are transient, frozen with the relevant target, and never journal facts.

A durable delivery consumes its matching materialized handoff. Its later
retirement changes only the proved merge-operation metadata: it preserves the
real index, including staged versus unstaged distinctions, and every worktree
byte. Retrying that physical effect is safe; an explicit rematerialization may
perform the same proved retirement before making a new judged projection.
Foreign Git state, generic Git-operation recovery, automatic commits, and
index- or worktree-rewriting cleanup remain outside Keiyaku's authority.

Terminal cleanup removes a managed worktree only when its bytes and head are
sealed by the Contract's recorded custody. Unsealed claimed bytes are retained.
For abandoned unsealed bytes, Git may produce ephemeral, ref-free recovery
evidence before removal; it is not a journal fact, retention promise, or source
of later lifecycle authority. Physical removal precedes Place release and ref
cleanup. A retained path or nonredundant ref is visible lag, never reversal of
an accepted outcome.

Target-placement fence acquisition is bounded and cancellable without breaking
its current holder. Cancellation does not replace the expected-reference proof
or undo a confirmed publication. Resolving an uncertain publication uses its
original fact identities and independent bounded observation, not the cancelled
execution channel. A successful readback confirms only the original offer; it
does not authorize replaying that offer's product effects.
