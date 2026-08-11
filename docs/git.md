# Git

Git owns the Git world that carries contract journals, candidate bytes,
target refs, managed worktrees, and Keiyaku-owned pins. Keiyaku owns the
deterministic managed path, ref, and pin topology; the agent owns the working
content; and the journal owns only the tendered candidate. Git is the
custody layer for physical object availability and the sole owner of
reconciliation behavior.

## Git World

One Git repository carries the private Git map, target refs, and worktrees.
The physical map and its layout are implementation-private and reachable under
one Git ref. A contract's journal blob is its `ContractHead`; unrelated
Git movement does not change that contract. Discovery follows worktree
identity to the common repository. Scope resolution pins both the caller
worktree and the primary worktree for the one Git world.

Targeted observation and admission are
`O(touched journal size + bounded ancestor depth)`, never `O(world)`. A
full-world observation is `O(N)`. The private Git map has no cache,
current-state snapshot, second or per-contract Git ref, or in-repository
fact index. The deterministic managed refs and pins are topology and
reachability only; they are not a Git-state index or a second fact store.
Git also owns observation of the invocation worktree's current branch. It
returns the canonical `refs/heads/...` symbolic `HEAD`, or absence when that
worktree is detached; no higher layer runs or interprets Git for this fact.
Variable-length public identities do not determine Git depth. A journal
locator uses a fixed-width strong digest of the complete ContractId as a
bounded-fanout Git tree path, while the journal bytes retain and canonically
verify the complete identity. The digest is a private locator, never contract
identity or a second uniqueness authority.

Git mints `ContractCoordinates.start` at bind. With a target it is
the resolved target head; without a target it is the caller worktree's current
`HEAD`. It is the initial managed-worktree commit and the original comparison
point for a `here` workspace. A targeted here contract is legal only while the
caller's symbolic `HEAD` is that target.

An explicit target must exist at bind observation. Absence is returned to the
library as `target-missing` before any journal or ref publication. Git
never creates the target branch and never substitutes another ref or the
caller's current `HEAD` for it.

A target is an optional Git ref because a claimed placement may move it.
`workspace: "worktree"` gives Git ownership of one deterministic delivery ref
and linked worktree; its branch remains independent from the target.
`workspace: "here"` uses the pinned caller worktree in place and never takes
ownership of that worktree or its branch. Here is a commit-in-place capability,
not a foreign-target delivery mode: bind refuses a targeted here workspace
whose symbolic `HEAD` differs from that target or is detached. Delivery refuses
before tender when the workspace no longer names its recorded target. A
targetless here contract remains legal.

The Git ref, managed delivery namespace, and candidate-pin namespace have
this one Git owner. The library boundary rejects a target that names any
of them before coordinates are recorded; target input and canonicalization are
defined only in [public-api.md](public-api.md).

Git derives each managed delivery-ref leaf, candidate-pin leaf, and
worktree basename from the complete ContractId using one private physical-name
projection. It replaces the validated coordinate's structural `/` separator
with `-`; for example, `kei/example` materializes as `kei-example`. The family
prefix comes from the identity itself and is neither added nor reconstructed by
Git. This stable projection does not reuse title normalization. These
names are deterministic topology, not public identity or a second legality
authority.

## Delivery Preparation And Placement

Preparation consumes only the state coordinates projected from that attempt and
a title stamped with the `DocumentKey` from which it was derived. It does not
observe, fold, or judge contract lifecycle state, decode a document, request a
callback, or import a protocol body. For a target contract, its mechanical
target-head read supplies the delivery predecessor. For a targetless contract,
the supplied `start` coordinate is the predecessor used to derive patch
identity and there is no target ref operation.

Preparation uses the one core mechanical-result primitive. Delivery returns
`Preparation<DeliverData, DeliveryPreparationFailure>` and review returns
`Preparation<ChangeId, ReviewPreparationFailure>`; the prepared payload field
is always `data`. Git defines neither bespoke delivery/review preparation
unions nor a wrapper supertype. Delivery's data contains the
candidate, patch, and predecessor identities; review's data is the captured
patch identity. A mechanical preparation failure is data for the attempt's
completed legal decision, not a lifecycle refusal. The candidate is the selected workspace content: the
deterministic managed worktree in worktree mode or the pinned caller worktree
in here mode. Clean content uses its existing `HEAD`. Dirty content, including
untracked files, is captured through a private index and materialized as a
deterministic candidate commit/tree without changing the caller's index or
worktree. Its commit message defaults to `<contract-id>: <title>` followed by
`Keiyaku-Contract: <contract-id>`. A caller-supplied `message` replaces the
message bytes only; candidate tree, parent, identity rules, and lifecycle
meaning do not change.

Git uses commit identity for `SnapshotId` and one stable patch-ID
method for `ChangeId`. Review captures that patch identity from current
worktree content against the contract `start`; deliver records it against its
observed delivery predecessor. Without target drift, those two computations
produce the same patch identity. A pure rebase changes the delivery predecessor
and candidate coordinates but preserves that identity; a conflict resolution
that changes the patch does not. When a target is declared, the candidate must
descend from the observed predecessor. Equality between predecessor and
candidate is a valid assertion. Target drift ends that attempt; only a later,
explicitly started attempt may prepare from the new target head. A targetless
claimed admission appends the same fact without a ref operation.

Targeted claimed placement is one serialized Git operation per canonical
target ref. Its fence begins before checkout preconditions are observed and
ends only after the journal and target transaction has been published and the
target checkout has followed it. Admission atomically asserts
`target == expectedPredecessor`, moves it to the candidate, and appends
`claimed`; filesystem materialization remains a second physical write inside
that same fence.

When the target checkout is not the tender source, placement follows Git merge
semantics. Before publication, each registered checkout of the target must
admit the predecessor-to-candidate two-tree merge of its current index, have no
worktree modification on a predecessor-to-candidate changed path, and have no
untracked path colliding with a candidate addition. The index merge preserves
staged entries that the candidate does not change. A staged entry that Git
cannot carry through that merge refuses; unrelated staged, unstaged, and
untracked paths are preserved. Every failure returns
`checkout-not-followable` with the checkout, target, exact implicated paths,
and reason `staged`, `conflict`, or `untracked`; neither the claimed fact nor
target ref is written. On success Git performs that same two-tree index and
worktree update immediately after publication and reports a followed target
checkout effect.

When a targeted here workspace is itself the target checkout, placement
follows Git commit semantics. Its captured dirty bytes are the verified
candidate, so merge preconditions do not apply. After publication Git sets
that checkout's index to the candidate tree and does not write its worktree.
Captured staged, unstaged, and untracked bytes therefore become the clean
candidate. Bytes edited after capture remain ordinary unstaged changes.
Staging intent created after capture may be reclassified as unstaged, but its
worktree bytes are never discarded.

The target fence removes ordinary post-admission projection. Process death or
a failed follow after ref publication can leave only the current placement's
unfinished second half. It has no marker and no ancestor search. Recovery
proceeds only while the target still names the claimed candidate. Each checkout
is recovered from its own provable shape rather than a remembered arm. For an
ordinary checkout, candidate index and worktree entries on every
predecessor-to-candidate changed path prove the follow complete while preserving
unrelated staged and unstaged entries. Candidate worktree entries with
predecessor index entries on those paths complete through an index-only
two-tree merge; predecessor entries in both may complete the same index and
worktree update. A full candidate worktree whose changed-path index is not yet
at the candidate completes through full candidate index alignment. Any other
shape or failed update reports typed target-checkout lag and performs no further
mutation. A later placement cannot pass its preconditions while that checkout
is behind, so unfinished placements do not accumulate.

Git admission builds raw Git objects and uses one
`update-ref --stdin --no-deref` transaction. It recognizes canonical admitted
entry bytes and may classify an unknown result from durable facts, but it never
redecides an offer. A known rejection preserves its diagnostic and lets
protocol compare freshly observed asserted coordinates with the failed
attempt. Movement of the Git or target coordinate invalidates that offer
and begins a fresh semantic attempt; the old offer bytes are never rebuilt or
replayed. With no coordinate movement the rejection is a hard
`publication-failed`. No layer parses Git prose, silently
adopts a newer document or target, or treats the recovery observation as a
second acceptance authority.

The same private-tree commit may contain opaque companion updates alongside
journal appends. A companion is exactly one validated Git path and byte value;
paths are unique within the Offer and cannot collide with the format marker or
a touched journal path. Git validates this generic structure, writes the blobs,
and publishes them under the same root CAS. It does not decode a companion or
know TaskHolder semantics. Because the root ref is the atomic commit point,
unknown-outcome recovery from the admitted journal entries also proves that
every companion in that Offer landed; a partial publication is authority
corruption, not a recoverable state.

## Document Boundary

Git and protocol have no document callback, decoded-document import, or
document interpretation. They receive no raw document projection for a write
attempt. Bind protocol receives the title scalar only to mint the normalized
ContractId defined in [model.md](model.md); Git receives only the resulting
identity. The only document-derived Git input to delivery preparation is
the title scalar stamped by its `DocumentKey`, as defined in
[document.md](document.md); Git does not persist or cache either
derivation. Review preparation receives no document-derived value. Protocol
combines its mechanical patch identity with the document key from the attempt
observation to form the testimony subject. Git does not judge whether that
subject is current.

The one internal post-admission document read is a protocol projection over one
full-world Git observation. It folds and filters nonterminal contracts and
returns exactly `{ contract, documentBytes }` for the library's Region reader.
It exposes no `DocumentKey`, decoded field, Region token, Git snapshot, or
public method. This read is not an admission handoff or receipt and does not
alter the result of the write that preceded it.

## Reconciliation

Reconciliation computes desired-minus-actual effects from accepted facts and
fresh external observation. It is idempotent without process-local receipt data
and across a process restart. It writes no journal fact, never reverses
admission, and is the only repair primitive for accepted-but-lagged effects.

Each Contract reconciliation is one serialized Git effect decision. Git takes
one per-Contract coordination lock in the common Git directory, then observes
that Contract's current journal and worktree topology while holding the lock,
applies every ref, worktree, marker, and hook effect, and releases the lock.
Callers supply the Contract identity, never a previously folded state. The lock
contains no domain fact and is never removed with a managed worktree. Different
Contracts do not share this lock. Lock acquisition waits for the current effect
decision to finish rather than imposing a timeout shorter than a configured
hook command; process death releases the SQLite transaction. A Hook command has
one additional marker-local execution lock held by its detached Git runner for
the command's complete process lifetime. The runner, not the calling reconcile
process, reads the frozen command and durably records its resulting progress
before releasing that lock. Thus caller death may release the Contract lock but
cannot let a later reconcile overlap the still-running Hook command.

Ordinary admission does not take the per-Contract effect lock. Targeted
placement takes the separate canonical target fence described above. A public
mutation that admits a newer fact performs its mandatory reconciliation through
the per-Contract serialized entry, where it observes that newer state. Thus a
reconcile that began from an active state may finish its effects after a
terminal fact is admitted, but the terminal mutation's queued reconcile
observes terminal state and is the later effect decision.

Failure to observe or apply the requested topology is an explicit reconcile
result, not an untyped Git exception. The failed result retains every effect
that completed before the failure and identifies whether observation or effect
application failed. It makes no claim that an unreported effect did or did not
happen. Authority corruption and internal invariant failure remain exceptions.

For an active worktree contract, reconciliation creates the deterministic
linked worktree only when it is missing, and repairs only its Keiyaku-owned
refs and pins. It never resets, switches, or detaches an existing worktree.
For a here contract, reconciliation never creates, removes, switches,
detaches, or resets the caller-supplied worktree or its branch.

Target-checkout reconciliation exists only to finish the current claimed
placement's interrupted follow. It takes the same canonical target fence as
placement, rereads the claimed delivery and target ref, and applies only the
shape-proven recovery described above. It never adopts an ancestor as a base,
projects an older claim after a newer target movement, or retries an ordinary
pre-publication refusal. A completed checkout produces no effect; a completed
recovery reports `recovered`; an incompatible shape reports
`target-checkout-retained` and leaves every byte untouched. A checkout already
at the candidate needs no recovery effect.

A pending tender keeps its candidate reachable through a Keiyaku-owned pin in
either workspace mode. Cleanup never moves the target ref.

Terminal removal of a managed worktree is legal only when its status, including
untracked files, is clean and one of two commit arms holds: `HEAD` is the last
accepted candidate and its tree matches that candidate's tree, or `HEAD` is the
creation start and its tree matches the start tree. An abandonment with no
delivery uses the start arm. Every such removal uses `git worktree remove`
without `--force`; Keiyaku never invokes `git worktree remove --force`. When
the test does not hold, reconciliation retains the worktree and its
Keiyaku-owned reachability refs and pins, then reports the typed
`worktree-retained` cleanup lag. Retention never reverses or changes an
accepted outcome.

### Managed Worktree Hooks

Managed-worktree hooks are part of the typed worktree effect, not Contract
lifecycle facts or cross-product settlement. Git receives only this opaque
pure value from the library; it never reads Settings or interprets command
meaning:

```ts
type HookCommand = Readonly<{ argv: readonly string[]; timeoutMs: number }>
type WorktreeHooks = Readonly<{
  create: readonly HookCommand[]
  destroy: readonly HookCommand[]
}>
```

Each command runs directly, without a shell, in the managed worktree and
inherits the invocation environment. The shared process runtime bounds
stdout/stderr tails, enforces `timeoutMs`, and terminates the command process
tree on timeout. Commands must be serially replay-safe. The guarantee is
at-least-once: runner death after a command produces its effect and before its
progress is durably recorded can make a later runner execute that command
again. Concurrent replay is not required.

Immediately after creating a worktree, Git atomically writes
`keiyaku/hooks.json` beneath that linked worktree's Git administration
directory. The marker is outside candidate content and disappears only when
Git removes that managed worktree. The current hard-cut marker has version
`1`, freezes the complete create/destroy command pair, and records each phase
as `pending` with its next command index, `failed` with its command index and
typed process failure, or `ok`. Every marker replacement uses a unique
same-directory temporary file, fsyncs the file, renames it, and fsyncs the
parent directory. Empty command arrays advance directly to `ok`.

An active worktree with no marker freezes the current supplied pair and runs
create commands. A `pending` create phase resumes from its stored next index.
An `ok` create phase never runs again. A `failed` phase reports its stored lag
without running during ordinary reconciliation. Explicit
`reconcile({ retryHooks: true })` resumes that failed phase from its stored
command, still using the frozen pair; retry never recaptures current settings.
For each pending index, the detached runner takes the execution lock, rereads
the marker, and runs only when that exact index is still pending. A runner that
queued behind an earlier caller therefore observes the earlier progress and
does not repeat it. No running marker, pid lease, heartbeat, or age-based
recovery state exists.

The create order is worktree add, marker freeze, then create commands. A create
failure retains the worktree and does not reverse or abandon the accepted
Contract. The destroy order is the existing cleanliness and HEAD/tree gate,
then frozen destroy commands, worktree removal, and ref cleanup. A destroy
failure retains the worktree and all reachability refs. Settings changes affect
only a future worktree whose marker has not yet been frozen. Git does not expose
a generic hook registry, lifecycle event bus, backend interface, or hook fact.
Hook commands must not recursively invoke a mutation or reconciliation for the
same Contract: the outer effect decision owns that Contract's lock until the
command returns.

```ts
type ReconcileResult = Readonly<{
  effects: readonly Effect[]
  lag: readonly ReconcileLag[]
}>

type ReconcileLag =
  | Readonly<{ kind: "worktree-retained"; path: string }>
  | Readonly<{
      kind: "target-checkout-retained"
      path: string
      target: string
      diagnostic: string
    }>
  | Readonly<{
      kind: "worktree-hook-failed"
      phase: "create" | "destroy"
      path: string
      command: number
      failure: HookFailure
    }>
  | Readonly<{
      kind: "reconcile-failed"
      stage: "observation" | "effect"
      diagnostic: string
    }>

type HookFailure =
  | Readonly<{
      kind: "exit"
      code: number
      stdout: string
      stderr: string
      truncated: boolean
    }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "spawn-error"; diagnostic: string }>
  | Readonly<{ kind: "unknown-exit" }>

type Effect =
  | Readonly<{
      kind: "worktree"
      path: string
      action: "created" | "removed" | "unchanged"
    }>
  | Readonly<{
      kind: "target-checkout"
      path: string
      target: string
      action: "followed" | "recovered"
    }>
  | Readonly<{
      kind: "ref"
      name: string
      before: GitObjectId | null
      after: GitObjectId | null
      action: "created" | "updated" | "removed" | "unchanged"
    }>
```

`keiyaku.reconcile()` returns the contract's `ReconcileResult` as its public
`ReconcileReport`. World reconciliation returns:

```ts
type RepoReconcileItem = Readonly<{
  contractId: ContractId
  report: ReconcileReport
}>

type RepoReconcileReport = Readonly<{
  contracts: readonly RepoReconcileItem[]
}>
```

It contains one typed report for every observed contract. A failure lag does
not discard successful effects or reports and never becomes an aggregate
exception. Contract and world reconciliation use the same lag vocabulary.
Git owns no Task namespace bytes or ContractId-to-namespace policy; that
post-physical projection belongs to [settlement](settlement.md).

Effects and lag are transparent data. `changed` is derivable from effect
actions, resource coordinates are already in each effect, and lifecycle state
remains a journal projection. Commands and public reports expose only effects
actually observed in that operation and the flat `lag` array above; lag is not
nested in an effect or a second cleanup report. A report with lag is safe to
retry because every later reconcile starts from durable facts and fresh
topology rather than an in-memory receipt.

## Identities And Bytes

Keiyaku records delivery identity in durable facts: predecessor, candidate, and
patch identity. Git stores and resolves the Git bytes behind those
identities. A journal entry is not a Git reachability edge. Git retains
no additional Keiyaku diff blob, permanent ref, or state index solely to
preserve a tender.

Terminal cleanup releases the delivery ref, candidate pin, and managed
worktree only after the applicable cleanup rule succeeds. A retained worktree
retains its reachability topology. Once the topology is released, Git pruning
may make a recorded predecessor or candidate unavailable. That availability is
Git state, while delivery identities remain durable contract facts. The
public `Delivery.diff()` contract and its git-unavailable result are
defined in [public-api.md](public-api.md).

No cleanup operation rewrites a target ref. A targetless claimed contract and a
targeted contract whose target later moves share the same byte-custody rule.
