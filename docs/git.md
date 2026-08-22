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
per Contract. The capability also pins one nonblank Git executable coordinate;
ordinary, streamed-output, and environment-augmented Git subprocesses all use
that exact coordinate. Git modules do not read environment configuration or
reinterpret the coordinate as a repository path.

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
`HEAD`. It is the initial managed-worktree commit.

Bind derives those coordinates anew inside every semantic attempt from one
target-selection intent: an explicit target, the current attached branch, or
targetless. Current-branch intent is resolved in that same observation. An
attached existing branch becomes the canonical `refs/heads/...` target and
start snapshot. A detached committed `HEAD` is targetless and starts at that
`HEAD`. An unborn `HEAD` returns `unborn-head` and is never classified as
`target-missing`. The same atomic admission transaction asserts only the ref
fact sealed into `coordinates.start`: the selected target ref's OID, or
dereferenced `HEAD` OID when there is no target. Every assertion is a
non-mutating `verify`; apart from the state-ref CAS append, admission never
updates, creates, deletes, or symbolically updates a ref. An OID movement,
identity collision, or Git CAS retry therefore discards the attempt and
re-observes coordinates; a fresh read alone is not the currentness judge.

An explicit target must exist at bind observation. Absence is returned to
the library as `target-missing` before any journal or ref publication. Git
never creates the target branch and never substitutes another ref or the
caller's current `HEAD` for it. A targetless bind requires a dereferenceable
`HEAD`; a fresh repository with an unborn `HEAD` returns the typed
`unborn-head` refusal without inventing a snapshot or publishing state.

A target is an optional Git ref because a claimed placement may move it.
`workspace: "worktree"` gives Git ownership of one deterministic delivery ref
and linked worktree; its branch remains independent from the target.

The Git ref, managed delivery namespace, and candidate-pin namespace have
this one Git owner. The library boundary rejects a target that names any
of them before coordinates are recorded; target input and canonicalization are
defined only in [public-api.md](public-api.md).

Managed delivery and candidate-pin leaves are deterministic private topology
derived from the complete ContractId. They are never public identity or a
second legality authority.

Git does not derive a managed worktree path from ContractId. Workspace
appointment owns Place allocation; Git consumes an explicit appointed Place
and realizes the worktree only at
`<primary-worktree>/.keiyaku/wt/<place>`. Primary and linked worktrees
share that appointed path. Git does not write repository `info/exclude` for
`.keiyaku/`. The path is not stored in the Contract journal. Git never
derives, scans, or adopts another managed-worktree coordinate from Contract
identity.

Terminal cleanup proves the appointed path is physically absent before Place
release. A retained physical path remains explicit lag; absence is the proof of
cleanup, not appointment metadata.

Git owns workspace cleanliness and target lag at the appointed path, counting
workspace `HEAD` against the same-epoch frozen `targetObservation.head` and
never a live target ref.
A named target with a missing frozen head is unknown. Clean means empty
staged, unstaged, untracked, and submodule sets; otherwise dirty;
unavailable when unobservable. An unappointed managed Contract has no
worktree to probe. These facts are not persisted.

## Tender, Integration, And Diff Ownership

Git owns tender capture, integration preparation, worktree-content ChangeId
materialization, recorded integration-pair diff reads, and disposable
Verification scratch custody. Protocol composes these typed capabilities
directly; there is no generic preparation wrapper. Managed worktrees remain
governed by the reconciliation rules below.

## Delivery Preparation And Placement

Delivery preparation consumes the attempt's coordinates, delivery policy,
dirty authorization, and optional caller testimony. It does not judge Contract
lifecycle or decode documents. A targeted tender integrates against one frozen
target head; a targetless tender has no target-ref operation.

Git returns mechanical data or typed failure to the lifecycle decision. Dirty
content refuses delivery and Verification unless `includeDirty` is true;
review observes ordinary dirty paths without that authorization. Dirty
submodule internals always refuse because the superproject tree cannot seal
them.

`includeDirty` captures the complete non-ignored final tree in a private index
without changing the real checkout. The tender message contains the Contract
Markdown and deterministic actor/timestamp testimony; caller message replaces
only its subject.

After accepted dirty delivery, reconciliation may project the recorded tender
into an eligible managed worktree without writing later edits. Tender and
ChangeId remain the candidate identities; target movement never changes them.

`SnapshotId` is commit identity. ChangeId is one byte-sensitive identity for the
immutable Contract start to captured tender tree, including binary, mode, path,
and whitespace bytes, independent of diff presentation configuration. Delivery
and review share it without creating a durable review snapshot. It changes only
with reviewed content, not target movement; later integration failure is a
placement stop and never changes the admitted review subject.

`requireBranchesToBeUpToDate` is the target freshness policy. When disabled,
Git performs one three-way squash integration against the frozen target head.
Unrelated histories and structured conflicts are typed failures naming the
judged target and conflict paths; the judge never edits an agent worktree.

Workspace observations expose merge state separately from dirty counts. A
materialized merge is current workspace state; an unmaterialized deliver
conflict exists only in its mutation result and is not fabricated into later
reads.

When deliver asks to materialize a judged conflict, Git projects that judged
target into the appointed workspace without choosing ours/theirs, committing,
or moving a ref. This is recovery projection, not a second conflict judge.

Unmerged index entries refuse as `unmerged-paths` before delivery admission. A
resolved merge remains dirty for authorization; `includeDirty` captures the
already materialized final bytes as the tender without judging the conflict
again.

Integration requires Git's structured merge-tree capability; unsupported Git is
a typed integration failure. Targetless delivery does not need it.

Targeted claimed placement is one serialized Git operation per canonical
target ref. Its fence begins before checkout preconditions are observed and
ends only after the journal and target transaction has been published and the
target checkout has followed it. Admission atomically asserts
`target == currentIntegration.predecessor`, moves it to
`currentIntegration.snapshot`, and appends `claimed`; filesystem materialization
remains a second physical write inside that same fence. If the target moved after
delivery admission or Verification, the completion protocol acquires the same
fence, integrates the persisted tender against the freshly observed target,
materializes a new integration commit from the original delivery metadata, and
admits `reintegrated` with the target assertion. Placement then retries against
that folded integration. The original delivery bytes and ChangeId remain
unchanged.

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

The library owns document decoding. Protocol derives the current document once
from its observed attempt, verifies the stamped `DocumentKey`, and passes the
title and complete Markdown bytes to Git for delivery preparation. Git treats
both as opaque commit-message inputs and neither decodes nor caches them. Bind
protocol receives the title scalar only to mint the normalized ContractId
defined in [model.md](model.md). Review preparation receives no
document-derived value. Protocol combines its mechanical patch identity with
the document key from the attempt observation to form the testimony subject.
Git does not judge whether that subject is current.

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
bytes therefore remain removable even when ordinary status is dirty.

An abandoned managed worktree whose `HEAD` or complete non-ignored tree is not
sealed receives one ephemeral recovery commit before removal. The commit names
the captured tree, parents the observed workspace `HEAD`, carries the Contract
identity in its message, and is deliberately left without a ref or durable
fact. If destroy hooks change the captured `HEAD` or tree, cleanup writes a
second recovery commit over the final tree with the first recovery as parent;
the reported tip therefore keeps both captures reachable together while it
survives. The result exposes only that final tip and labels it ephemeral. Git
may prune the entire recovery chain at any time allowed by repository policy.
Ignored bytes are outside the capture and are removed with the worktree. Dirty
submodule internals cannot be represented by the superproject tree and still
retain the worktree. Claimed cleanup likewise retains every unsealed `HEAD` or
tree rather than manufacturing recovery evidence.

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
