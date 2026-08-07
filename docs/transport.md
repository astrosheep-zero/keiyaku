# Transport

Transport owns the Git world that carries contract journals, candidate bytes,
target refs, managed worktrees, and Keiyaku-owned pins. Keiyaku owns the
deterministic managed path, ref, and pin topology; the agent owns the working
content; and the journal owns only the tendered candidate. Transport is the
custody layer for physical object availability and the sole owner of
reconciliation behavior.

## Git World

One Git repository carries the private carrier map, target refs, and worktrees.
The physical map and its layout are implementation-private and reachable under
one carrier ref. A contract's journal blob is its `ContractHead`; unrelated
carrier movement does not change that contract. Discovery follows worktree
identity to the common repository. Scope resolution pins both the caller
worktree and the primary worktree for the one Git world.

Targeted observation and admission are
`O(touched journal size + bounded ancestor depth)`, never `O(world)`. A
full-world observation is `O(N)`. The private carrier map has no cache,
current-state snapshot, second or per-contract carrier ref, or in-repository
fact index. The deterministic managed refs and pins are topology and
reachability only; they are not a carrier-state index or a second fact store.
Variable-length public identities do not determine carrier depth. A journal
locator uses a fixed-width strong digest of the complete ContractId as a
bounded-fanout Git tree path, while the journal bytes retain and canonically
verify the complete identity. The digest is a private locator, never contract
identity or a second uniqueness authority.

The transport mints `ContractCoordinates.start` at bind. With a target it is
the resolved target head; without a target it is the caller worktree's current
`HEAD`. It is the initial managed-worktree commit and the original comparison
point for a `here` workspace. It does not constrain which branch that workspace
has checked out.

An explicit target must exist at bind observation. Absence is returned to the
library as `target-missing` before any journal or ref publication. Transport
never creates the target branch and never substitutes another ref or the
caller's current `HEAD` for it.

A target is an optional Git ref because a claimed placement may move it. The
target and a workspace branch are independent. `workspace: "worktree"` gives
transport ownership of one deterministic delivery ref and linked worktree.
`workspace: "here"` uses the pinned caller worktree in place. It never takes
ownership of that worktree or its branch.

The carrier ref, managed delivery namespace, and candidate-pin namespace have
this one transport owner. The library boundary rejects a target that names any
of them before coordinates are recorded; target input and canonicalization are
defined only in [public-api.md](public-api.md).

Transport derives each managed delivery-ref leaf, candidate-pin leaf, and
worktree basename from the complete ContractId using one private physical-name
projection. The projection preserves the normalized contract segment and adds
the fixed `kei-` family namespace; for example, `kei/example` materializes as
`kei-example`. These names are deterministic topology, not public identity or a
second legality authority. Platform-specific filename concerns do not enter
identity normalization.

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
is always `data`. Carrier defines neither bespoke delivery/review preparation
unions nor an adapter or wrapper supertype. Delivery's data contains the
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

The Git carrier uses commit identity for `SnapshotId` and one stable patch-ID
method for `ChangeId`. Review captures that patch identity from current
worktree content against the contract `start`; deliver records it against its
observed delivery predecessor. Without target drift, those two computations
produce the same patch identity. A pure rebase changes the delivery predecessor
and candidate coordinates but preserves that identity; a conflict resolution
that changes the patch does not. When a target is declared, the candidate must
descend from the observed predecessor. Claimed admission atomically asserts
`target == expectedPredecessor`, moves it to the candidate, and appends
`claimed` in one repository transaction. Equality between predecessor and
candidate is a valid assertion. Target drift ends that attempt; only a later,
explicitly started attempt may prepare from the new target head. A targetless
claimed admission appends the same fact without a ref operation.

Carrier admission builds raw Git objects and uses one
`update-ref --stdin --no-deref` transaction. It recognizes canonical admitted
entry bytes and may classify an unknown result from durable facts, but it never
redecides an offer. A known rejection preserves its diagnostic and lets
protocol compare freshly observed asserted coordinates with the failed
attempt. Movement of the carrier or target coordinate invalidates that offer
and begins a fresh semantic attempt; the old offer bytes are never rebuilt or
replayed. With no coordinate movement the rejection is a hard
`publication-failed`. No layer parses Git prose, silently
adopts a newer document or target, or treats the recovery observation as a
second acceptance authority.

## Document Boundary

Transport and protocol have no document callback, decoded-document import, or
document interpretation. They receive no raw document projection for a write
attempt. Bind protocol receives the title scalar only to mint the normalized
ContractId defined in [model.md](model.md); carrier receives only the resulting
identity. The only document-derived transport input to delivery preparation is
the title scalar stamped by its `DocumentKey`, as defined in
[document.md](document.md); transport does not persist or cache either
derivation. Review preparation receives no document-derived value. Protocol
combines its mechanical patch identity with the document key from the attempt
observation to form the testimony subject. Carrier does not judge whether that
subject is current.

The one internal post-admission document read is a protocol projection over one
full-world carrier observation. It folds and filters nonterminal contracts and
returns exactly `{ contract, documentBytes }` for the library's Region reader.
It exposes no `DocumentKey`, decoded field, Region token, carrier snapshot, or
public method. This read is not an admission handoff or receipt and does not
alter the result of the write that preceded it.

## Reconciliation

Reconciliation computes desired-minus-actual effects from accepted facts and
fresh external observation. It is idempotent without process-local receipt data
and across a process restart. It writes no journal fact, never reverses
admission, and is the only repair primitive for accepted-but-lagged effects.

For an active worktree contract, reconciliation creates the deterministic
linked worktree only when it is missing, and repairs only its Keiyaku-owned
refs and pins. It never resets, switches, or detaches an existing worktree.
For a here contract, reconciliation never creates, removes, switches,
detaches, resets, or aligns the caller-supplied worktree or its branch. A
pending tender keeps its candidate reachable through a Keiyaku-owned pin in
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

```ts
type ReconcileResult = Readonly<{
  effects: readonly Effect[]
  lag: readonly ReconcileLag[]
}>

type ReconcileLag = Readonly<{
  kind: "worktree-retained"
  path: string
}>

type Effect =
  | Readonly<{
      kind: "worktree"
      path: string
      action: "created" | "removed" | "unchanged"
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
type RepoReconcileItem =
  | Readonly<{ contractId: ContractId; kind: "reconciled"; report: ReconcileReport }>
  | Readonly<{ contractId: ContractId; kind: "failed"; diagnostic: string }>

type RepoReconcileReport = Readonly<{
  contracts: readonly RepoReconcileItem[]
}>
```

It contains one typed item for every observed contract. A failed item does not
discard successful reports or become an aggregate exception.

Effects and lag are transparent data. `changed` is derivable from effect
actions, resource coordinates are already in each effect, and lifecycle state
remains a journal projection. Commands and public reports expose only effects
actually observed in that operation and the flat `lag` array above; lag is not
nested in an effect or a second cleanup report.

## Identities And Bytes

Keiyaku records delivery identity in durable facts: predecessor, candidate, and
patch identity. Transport stores and resolves the Git bytes behind those
identities. A journal entry is not a Git reachability edge. Transport retains
no additional Keiyaku diff blob, permanent ref, or state index solely to
preserve a tender.

Terminal cleanup releases the delivery ref, candidate pin, and managed
worktree only after the applicable cleanup rule succeeds. A retained worktree
retains its reachability topology. Once the topology is released, Git pruning
may make a recorded predecessor or candidate unavailable. That availability is
transport state, while delivery identities remain durable contract facts. The
public `Delivery.diff()` contract and its transport-unavailable result are
defined in [public-api.md](public-api.md).

No cleanup operation rewrites a target ref. A targetless claimed contract and a
targeted contract whose target later moves share the same byte-custody rule.
