# Git

Git owns the Git world that carries contract journals, candidate bytes,
target refs, managed worktrees, and Keiyaku-owned pins. Keiyaku owns the
deterministic managed path, ref, and pin topology; the agent owns the
working content; and the journal owns only the tendered candidate. Git is
the custody layer for physical object availability and the sole owner of
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

Targeted observation and admission are bounded by the touched journal and
selected ancestor depth, never by the complete world; a full-world observation
is the only complete-tree read. The private Git map has no independently
updated cache, current-state snapshot, second or per-contract Git ref, or fact
index. Managed refs and pins are topology only.
Git also owns the invocation worktree's current branch: the canonical
`refs/heads/...` symbolic `HEAD`, or absence when detached. No higher layer
runs or interprets Git for this fact.
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

The active/terminal layout is the only accepted format; runtime has no
predecessor-path reader, migration branch, or fallback.

## Call-Scoped Read Observation

A composite read freezes `refs/heads/keiyaku-state` once and shares one
immutable path-to-object observation across Contract, TaskHolder, and Dispatch
readers. Each product selects only its paths and remains the sole decoder,
canonical-byte validator, duplicate judge, sorter, and projector; Git knows no
product codec. Missing objects and transport failure remain typed read results.

Only Git creates and closes the read capability. It memoizes content-addressed
objects and target refs within the call, is invalid after the call, and never
restarts a failed transport. Workspace cleanliness is observed separately per
workspace against the target head frozen in that same call.

Every decision, recovery, fence, reconciliation, and settlement boundary
freezes refs independently. Immutable OID-addressed objects may be reused only
inside that epoch; ref results never authorize a later boundary. Targeted reads
walk only selected paths and bounded ancestors, while full-world reads alone
enumerate the complete tree. All repository observations are asynchronous, and
product owners create neither Git readers nor cross-call caches.

Git mints `ContractCoordinates.start` at bind. With a target it is the
resolved target head; without a target it is the caller worktree's current
`HEAD`. It is the initial managed-worktree commit and the original comparison
point for a `here` workspace. A targeted here contract is legal only while
the caller's symbolic `HEAD` is that target.

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

An explicit target must exist at bind observation. Absence is returned to
the library as `target-missing` before any journal or ref publication. Git
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

Git derives each managed delivery-ref leaf and candidate-pin leaf from the
complete ContractId using one private physical-name projection. It replaces
the validated coordinate's structural `/` separator with `-`; for example,
`kei/example` materializes as `kei-example`. The family prefix comes from
the identity itself and is neither added nor reconstructed by Git. This
stable projection does not reuse title normalization. These names are
deterministic topology, not public identity or a second legality authority.

Git does not derive a managed worktree path from ContractId. Workspace
appointment owns Place allocation; Git consumes an explicit appointed Place
and realizes the worktree only at
`<git-common-dir>/keiyaku/wt/<place>`. Primary and linked worktrees
therefore share that appointed path. The path is not stored in the Contract
journal. Git never derives, scans, or adopts another managed-worktree
coordinate from Contract identity.

Git's terminal worktree cleanup proves the appointed path is physically
absent before the workspace owner may release the Place. An
unregistered-but-existing appointed path is typed `worktree-retained` lag
and is not a successful cleanup. A path that is neither registered nor
present may report `unchanged` and still prove absence. An ordinary
unappointed terminal is not a missing-Place failure: appointment absence
is the proof that physical cleanup already completed.

Git owns workspace cleanliness and target lag at the appointed path, or at
the pinned caller worktree for `here`, counting workspace `HEAD` against
the same-epoch frozen `targetObservation.head` and never a live target ref.
A named target with a missing frozen head is unknown. Clean means empty
staged, unstaged, untracked, and submodule sets; otherwise dirty;
unavailable when unobservable. An unappointed managed Contract has no
worktree to probe. Here never fabricates a managed path. These facts are
not persisted.

## Tender, Integration, And Diff Ownership

Git owns tender capture, integration preparation, worktree-content ChangeId
materialization, recorded integration-pair diff reads, and disposable
Verification scratch custody. Protocol composes these typed capabilities
directly; there is no generic preparation wrapper. Managed worktrees remain
governed by the reconciliation rules below.

## Delivery Preparation And Placement

Delivery preparation consumes only the state coordinates and current document
projection from that attempt, pure `requireBranchesToBeUpToDate` and
`includeDirty` values, and optional caller message and actor testimony. It does
not observe, fold, or judge contract lifecycle state, decode a document,
request a callback, import Settings, or import a protocol body. For a target contract, Git observes
the current target head and constructs one squash integration against it. For a
targetless contract, the supplied `start` coordinate is the integration
predecessor, the tender is also the integration snapshot, and there is no target
ref operation.

It returns mechanical data or failure to the one lifecycle decision;
it is not a lifecycle judge. The tender is the selected managed or here
workspace content. Dirty content refuses delivery and Verification unless
`includeDirty` is true. Review needs no such authorization and discloses the
ordinary dirty paths and totals it observed. Dirty submodule internals always
refuse because the superproject tree cannot seal them.

When `includeDirty` is true, Git captures all non-ignored staged, unstaged, and
untracked final bytes through one private index and materializes a deterministic
tender commit/tree without changing the real `HEAD`, index, branch, or files.
It is complete-workspace authorization, not a staged-only mode or path selector.
Its commit message is the default `<contract-id>: <title>` subject or the
caller-supplied subject, one blank line, the complete current Contract Markdown
with one trailing newline, then one blank line and the final
`Keiyaku-Contract: <contract-id>` trailer. A supplied message replaces only the
subject. Tender and integration materialized by one preparation share one real
non-epoch timestamp and one author/committer pair. Actor testimony wins and
uses `keiyaku@localhost`; otherwise a complete repository-effective
`user.name`/`user.email` pair wins, with `Keiyaku <keiyaku@localhost>` as the
fallback when either value is absent. Private state commits retain their own
identity and message law.

`SnapshotId` is commit identity. ChangeId is one byte-sensitive identity for the
immutable Contract start to captured tender tree, including binary, mode, path,
and whitespace bytes, independent of diff presentation configuration. Delivery
and review share it without creating a durable review snapshot. It changes only
with reviewed content, not target movement; later integration failure is a
placement stop and never changes the admitted review subject.

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

The targeted checkout observation is a no-effects precheck. It accepts the
targeted coordinates and prospective snapshots, lists registered checkouts,
and returns ready follow arms or typed checkout/workspace refusals. It never
publishes, follows, or claims. Placement invokes it under the target fence;
audit may invoke it prospectively. Actual placement remains the only
publisher. Movement has precedence over placeability, operational observation
failure is `target.failed`, and stopped Verification answers `not-observed`.

When the target checkout is not the tender source, placement follows Git merge semantics.
Before publication, each registered checkout must admit the predecessor-to-candidate
two-tree merge of its current index, have no worktree modification on changed paths,
and have no untracked collision with a candidate addition. Unchanged staged, unstaged,
and untracked paths are preserved. A refusal returns `checkout-not-followable` with
the checkout, target, exact paths, and reason `staged`, `conflict`, or `untracked`;
the claimed fact and target ref remain untouched. Success performs the same two-tree
update after publication and reports its checkout effect.

The dry-run is the only followability judge. Ignored-byte custody then examines
only predecessor-to-candidate writes, never follows symlinks or enumerates
unrelated siblings, and lets Git judge whether a displaced scope contains
ignored untracked bytes. Any such byte refuses as `untracked`; observation
failure is nonpublishing `target-placement-failed`.

When a targeted here workspace is itself the target checkout, placement
follows Git commit semantics. Its captured dirty bytes are the verified
candidate, so merge preconditions do not apply. After publication Git sets
that checkout's index to the candidate tree and does not write its worktree.
Captured staged, unstaged, and untracked bytes therefore become the clean
candidate. Bytes edited after capture remain ordinary unstaged changes.
Staging intent created after capture may be reclassified as unstaged, but its
worktree bytes are never discarded.

The target fence has no post-admission marker or ancestor search. Recovery is
allowed only while the target names the claimed candidate. Candidate index and
worktree on every changed path prove completion. Candidate worktree with
predecessor index completes by index-only merge; predecessor index and
worktree complete by the full two-tree update; a full candidate worktree with a
noncandidate changed-path index completes by candidate index alignment. Other
shapes or failed updates report target-checkout lag without further mutation,
and later placement cannot pass while that checkout is behind.

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
