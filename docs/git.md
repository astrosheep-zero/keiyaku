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
worktree and the primary worktree for the one Git world. It also resolves the
absolute common Git directory once when constructing the internal repository
capability; later operations read that pinned value and do not rediscover it
per Contract.

Targeted observation and admission are
`O(touched journal size + bounded ancestor depth)`, never `O(world)`. A
full-world observation is `O(N)`. The private Git map has no independently
updated cache, current-state snapshot, second or per-contract Git ref, or fact
index. The prohibition is against a second update timeline and second
authority, not against organizing the one atomically updated state-tree value.
The deterministic managed refs and pins are topology and reachability only;
they are not a Git-state index or a second fact store.
Git also owns observation of the invocation worktree's current branch. It
returns the canonical `refs/heads/...` symbolic `HEAD`, or absence when that
worktree is detached; no higher layer runs or interprets Git for this fact.
Variable-length public identities do not determine Git depth. A journal
locator uses an `active` or `terminal` class followed by a fixed-width strong
digest of the complete ContractId as a bounded-fanout Git tree path, while the
journal bytes retain and canonically verify the complete identity. The digest
and class are private locators, never contract identity or a second uniqueness
authority. Each Contract exists at exactly one locator, and its path class must
equal the class derived by folding that journal. Appending a terminal fact
moves the complete journal from `active` to `terminal` in the same state-tree
update and state-ref CAS. A targeted lookup probes both classes; an active-world
reader enumerates only `contracts/active/**`.

The active/terminal layout is a hard format boundary. Existing state is moved
to the fold-derived locator before code that reads the new format is installed.
Runtime code has no predecessor-path reader, migration branch, or fallback.

## Call-Scoped Read Observation

A complete composite read uses one package-internal `GitReadObservation` for
one repository and one call. Git freezes `refs/heads/keiyaku-state` once,
reads that commit through one persistent `cat-file --batch`, obtains its root
tree from the commit object, enumerates that tree once, and validates the
format blob through the same batch. The resulting immutable path-to-object map
is shared by the Contract, TaskHolder, and Dispatch readers. Each owner selects
only its own paths and object IDs, requests its blobs, and remains the sole
decoder, canonical-byte validator, duplicate judge, sorter, and projection
owner. Git does not know any product path or codec.

The observation memoizes completed object results by object ID and target
resolution by refname. A missing requested object is a typed per-object result;
the product owner decides how that absence affects its read. Repeated rows that
name one target cause one target-ref read. The complete read therefore uses
`O(1) + O(distinct target refs)` Git processes, independent of owner count,
row count, and blob count. An empty private state needs no batch process unless
a consumer explicitly requests an object.

Only Git creates a decode channel or a read observation. A package-root public
call may own one channel and pass that read-only capability through protocol,
reconciliation, and settlement. The consumer may neither construct nor close
it, and returning or throwing from the public call closes its batch. The
capability is invalid afterward. If the batch process dies, remaining
dependent reads receive that same transport failure; Git does not start a
replacement channel. The channel carries only content-addressed object decode;
it does not carry a repository handle. An epoch receives the repository from
its caller's existing scope capability. Callback failure remains primary over
a simultaneous close failure; when the callback succeeds, a close failure is
returned to the caller.

Each legal observation boundary freezes refs independently. A public Contract
mutation uses one channel but opens a fresh ref epoch for every decision
attempt and, when reached, for publication recovery, a holder or target fence,
reconciliation, and settlement. Immutable objects already named by OID may be
decoded once and reused through the channel; ref resolutions are memoized only
inside their epoch and never authorize a later boundary. Admission consumes
the decision epoch's frozen journal bytes and tree-directory entries, so it
does not rediscover or decode that immutable base tree. The process topology
of one mutation is therefore `O(lawful epochs) + O(1)` decode processes, not
`O(contracts)` or `O(read sites)`.

A targeted epoch walks only the bounded tree ancestors of its exact paths and
the explicitly selected owner subtrees. It never expands the complete private
tree. A full-world read remains the only complete-tree traversal. When a
post-decision companion adds a path, Git extends the admission directories for
that path from the same frozen tree before object construction; it does not
reread the state ref or discard untouched siblings.

`Keiyaku.list`, each public single-Contract read, a complete Dispatch read, and
Kanshi own their call boundary. There is no all-tree blob prefetch, owner
prepare/finish protocol, owner-created Git process, cross-call cache,
cross-epoch ref cache, synchronous Contract-reader fallback, or product-named
Git reader.

Git mints `ContractCoordinates.start` at bind. With a target it is
the resolved target head; without a target it is the caller worktree's current
`HEAD`. It is the initial managed-worktree commit and the original comparison
point for a `here` workspace. A targeted here contract is legal only while the
caller's symbolic `HEAD` is that target.

Bind derives those coordinates anew inside every semantic attempt. The same
atomic admission transaction asserts only the ref fact sealed into
`coordinates.start`: an explicit target's OID, or dereferenced `HEAD` OID for a
targetless bind. Every assertion is a non-mutating `verify`; apart from the
state-ref CAS append, admission never updates, creates, deletes, or symbolically
updates a ref. An OID movement, identity collision, or Git CAS retry therefore
discards the attempt and re-observes coordinates; a fresh read alone is not the
currentness judge.

The symbolic branch and attachedness read for targeted `here` eligibility are
not Contract facts. They can refuse that decision observation, but admission
does not assert or persist them. Moving to another branch at the same OID
between observation and admission is therefore legal and invisible; Git must
not change the caller's checkout to restore the earlier observation.

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

A managed worktree has exactly one deterministic physical path:
`<git-common-dir>/keiyaku/wt/<contract-physical-name>`. Primary and linked
worktrees therefore derive the same path for one Contract. The path is a
read-time projection from the pinned common Git directory and ContractId; it is
not stored in the Contract journal, and there is no legacy-path fallback.

## Tender, Integration, And Diff Ownership

Tender capture and materialization live in `src/git/tender.ts`, including the
private-index workspace observation, dirty-workspace policy statistics, and
tender commit creation. `src/git/integration.ts` owns target observation,
ancestry and merge-tree semantics, integration snapshot and ChangeId
materialization, review preparation, and recorded integration-pair diff reads.
Protocol composes those typed capabilities directly for deliver and review;
there is no generic preparation wrapper.

`src/git/scratch.ts` owns only disposable Verification scratch worktrees,
including process-derived naming, materialization, disposal, and orphan
judgment. Managed worktrees remain governed by the reconciliation rules below.

## Delivery Preparation And Placement

Preparation consumes only the state coordinates projected from that attempt,
pure `requireBranchesToBeUpToDate` and `includeDirty` values, and a title
stamped with the `DocumentKey` from which it was derived. It does not observe,
fold, or judge contract lifecycle state, decode a document, request a callback,
import Settings, or import a protocol body. For a target contract, Git observes
the current target head and constructs one squash integration against it. For a
targetless contract, the supplied `start` coordinate is the integration
predecessor and there is no target ref operation. The tender is also the
integration snapshot only when no held-Task completion overlay is present.

Protocol may supply one opaque path/byte replacement after Settlement selected
a current holder and Task produced canonical completion bytes. Git reads the
path from the already planned integration tree, preserves its mode, writes the
replacement blob, and recomputes the integration tree and ChangeId. Git never
imports Task, parses Markdown, or decides a lifecycle transition. Missing or
non-blob input is returned to Protocol as mechanical evidence for the
Task-owned refusal. Because the overlay occurs before snapshot materialization,
review and delivery use the same final bytes without touching any worktree.

Preparation uses the one core mechanical-result primitive. Delivery returns
`Preparation<DeliverData, DeliveryPreparationFailure>` and review returns a
prepared review projection; the prepared payload field is always `data`. Git
defines neither bespoke delivery/review preparation unions nor a wrapper
supertype. Delivery's data contains the tender snapshot, complete integration
identity, squash method, and frozen policy; review's data contains the captured
integration ChangeId and any dirty workspace disclosure for that observation. A
mechanical preparation failure is data for the attempt's completed legal
decision, not a lifecycle refusal. The tender is the selected workspace
content: the deterministic managed worktree in worktree mode or the pinned
caller worktree in here mode. Clean content uses its existing `HEAD`. A dirty
workspace refuses before delivery or Verification unless `includeDirty` is
true. Review is observation, not delivery authorization: ordinary dirty bytes
do not refuse review, but the accepted review result discloses every
non-ignored staged, unstaged, and untracked path plus insertion/deletion totals
for the complete final tree relative to `HEAD`. Dirty submodule internals
always refuse because the superproject tree cannot seal or observe those bytes.

When `includeDirty` is true, Git captures all non-ignored staged, unstaged, and
untracked final bytes through one private index and materializes a deterministic
tender commit/tree without changing the real `HEAD`, index, branch, or files.
It is complete-workspace authorization, not a staged-only mode or path selector.
Its commit message defaults to `<contract-id>: <title>` followed by
`Keiyaku-Contract: <contract-id>`. A caller-supplied `message` replaces the
message bytes only; tender tree, parent, identity rules, and lifecycle meaning
do not change.

Git uses commit identity for `SnapshotId` and one stable patch-ID
method for `ChangeId`: `patch-id --stable` over the diff from the integration
predecessor to the integration tree. Review runs the same integration-aware
projection without creating a durable snapshot, running Verification, or
changing a worktree. A pure target rebase that leaves the integration patch
unchanged therefore preserves review testimony; a conflict resolution that
changes integration bytes does not.

A targetless held-Task delivery still materializes a deterministic integration
commit, parented by `start`, because its reviewed tree differs from the tender
tree. Manual placement of that commit carries implementation and Task
completion together; delivery preparation itself changes no world authority.

`requireBranchesToBeUpToDate` is a delivery-attempt policy. When true, a
targeted tender that does not descend from the observed target head returns
`integration-failed` with reason `not-based-on-target`; it admits no delivery
fact. When false, Git computes the common ancestor of the tender `HEAD` and
observed target head, then performs a three-way squash integration with that
ancestor as base, observed target head as ours, and tender tree as theirs. A
rebase therefore changes the integration base through ordinary Git history;
immutable Contract `start` remains birth topology and is not a mutable delivery
base. Git uses `merge-tree --write-tree -z --name-only`, then creates one
deterministic commit whose parent is the observed target head and whose message
is the tender message. It never checks out or edits an agent worktree. No common
ancestor produces `integration-failed` with reason `unrelated-histories`;
structured conflict paths produce reason `conflict`.

Squash integration requires Git 2.38 or a compatible structured
`merge-tree --write-tree` capability. Git probes that capability without
parsing version prose. Absence returns `integration-unsupported` with
`requiredGit: "2.38"`. Targetless delivery and the strict up-to-date path do
not require this capability.

Targeted claimed placement is one serialized Git operation per canonical
target ref. Its fence begins before checkout preconditions are observed and
ends only after the journal and target transaction has been published and the
target checkout has followed it. Admission atomically asserts
`target == integration.predecessor`, moves it to `integration.snapshot`, and appends
`claimed`; filesystem materialization remains a second physical write inside
that same fence. If the target moved after delivery admission or Verification,
placement returns `target-moved` with the expected and freshly observed target
coordinates. It appends no claimed fact, does not move the target, and never
re-integrates or reuses Verification inside that attempt.

Placement also observes the current TaskHolder projection in its fresh private
state epoch when delivery preparation named a holder. If that holder moved or
was released, or if the delivery ChangeId moved after preparation, placement
refuses before publication. The private state ref assertion, target assertion,
and target movement remain one atomic publication; no post-publication Task
writer or bookkeeping commit follows it.

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

## Identities And Bytes

Keiyaku records the tender snapshot and complete integration identity in
durable facts. Git stores and resolves the bytes behind those identities. A
journal entry is not a Git reachability edge. While active, the managed
delivery ref names the tender snapshot and the candidate pin names the
integration snapshot. The target makes a claimed integration reachable. Git
retains no additional Keiyaku diff blob, permanent ref, or state index.

Terminal cleanup removes an eligible managed worktree before releasing any
redundant ref. It compares the complete private-index workspace tree with the
journal-sealed start, tender, or integration trees and separately requires
`HEAD` to be a sealed start, tender, integration, or dirty-tender base commit
identity. The dirty-tender base is the sealed tender commit's first parent and
only matters when the complete workspace bytes equal a sealed tree. Matching
bytes therefore remain removable even when ordinary status is dirty, while a
new same-tree commit remains user work and is retained. No-delivery abandon
permits only the start tree and start `HEAD`. Dirty submodule internals are
never sealed by this proof.

Every Keiyaku-owned ref deletion is one atomic transaction that verifies its
surviving custodian ref. A candidate pin is released only when that ref preserves
the exact integration commit. A delivery ref may be released when the surviving
claimed integration preserves the exact tender tree; otherwise the tender ref
remains. Equal trees therefore suffice only for tender-byte custody, never as a
substitute for integration commit identity. A retained worktree retains its
reachability topology. Git pruning may make only identities whose custody has
lawfully ended unavailable. Identity facts remain durable Contract state. The
public `Delivery.diff()` contract and its git-unavailable result are defined in
[public-api.md](public-api.md).

No cleanup operation rewrites a target ref. A targetless claimed contract and a
targeted contract whose target later moves share the same byte-custody rule.
