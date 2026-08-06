# Transport

Transport owns the Git world that carries contract journals, candidate bytes,
target refs, managed worktrees, and Keiyaku-owned pins. It is the custody layer
for physical object availability and the sole owner of reconciliation behavior.

## Git World

One Git repository carries carrier refs, contract journals, target refs, and
worktrees. Its durable layout is:

```text
refs/heads/keiyaku-state
  -> carrier commit
    -> tree
      -> contracts/<machine-contract>.jsonl
      -> admission/**
      -> meta/format.json
```

The carrier branch is a physical Merkle map. A contract's journal blob is its
`ContractHead`; unrelated carrier movement does not change that contract.
Discovery follows worktree identity to the common repository. Scope resolution
pins both the caller worktree and the primary worktree for the one Git world.

The transport mints `ContractCoordinates.start` at bind. With a target it is
the resolved target head; without a target it is the caller worktree's current
`HEAD`. It is the initial managed-worktree commit and the original comparison
point for a `here` workspace. It does not constrain which branch that workspace
has checked out.

A target is an optional Git ref because a claimed placement may move it. The
target and a workspace branch are independent. `workspace: "worktree"` gives
transport ownership of one deterministic delivery ref and linked worktree.
`workspace: "here"` uses the pinned caller worktree in place. It never takes
ownership of that worktree or its branch.

## Delivery Preparation And Placement

For a target contract, transport freshly observes the target head as the
delivery predecessor. For a targetless contract, the recorded `start` is the
predecessor used to derive patch identity and there is no target ref operation.
The candidate is the selected workspace `HEAD`: the deterministic managed
worktree in worktree mode or the pinned caller worktree in here mode.

The Git carrier uses commit identity for `SnapshotId` and a stable patch
identity for `ChangeId`. When a target is declared, the candidate must descend
from the observed predecessor. Claimed admission atomically asserts
`target == expectedPredecessor`, moves it to the candidate, and appends
`claimed` in one repository transaction. Equality between predecessor and
candidate is a valid assertion. Target drift requires preparation from the new
target head. A targetless claimed admission appends the same fact without a ref
operation.

Carrier admission builds raw Git objects and uses one
`update-ref --stdin --no-deref` transaction. It recognizes canonical admitted
entry bytes and handles a typed unknown result by fresh transport observation.
It never turns Git prose into domain law.

## Reconciliation

Reconciliation computes desired-minus-actual effects from accepted facts and
fresh external observation. It is idempotent without process-local receipt data
and across a process restart. It writes no journal fact, never reverses
admission, and is the only repair primitive for accepted-but-lagged effects.

For a worktree contract, a `bound` fact creates or aligns the deterministic
delivery ref and linked worktree. A terminal fact removes those Keiyaku-owned
resources. For a here contract, reconciliation never creates, removes,
switches, detaches, resets, or aligns the caller-supplied worktree or its
branch. A pending tender keeps its candidate reachable through a
Keiyaku-owned pin in either workspace mode. Terminal cleanup removes that pin.
Cleanup never moves the target ref.

```ts
type ReconcileResult = Readonly<{
  kind: "aligned" | "cleaned" | "noop"
  deliveryRef: string | null
  worktreePath: string | null
  changed: boolean
  effects: readonly Effect[]
}>

type Effect =
  | Readonly<{
      kind: "worktree"
      path: string
      action: "created" | "updated" | "removed" | "unchanged"
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
  | Readonly<{ contractId: ContractId; kind: "failed"; error: string }>

type RepoReconcileReport = Readonly<{
  contracts: readonly RepoReconcileItem[]
}>
```

It contains one typed item for every observed contract. A failed item does not
discard successful reports or become an aggregate exception.

Effects are transparent data. Commands and public reports expose only effects
actually observed in that operation, followed by flat lag when an effect fails.

## Identities And Bytes

Keiyaku records delivery identity in durable facts: predecessor, candidate, and
patch identity. Transport stores and resolves the Git bytes behind those
identities. A journal entry is not a Git reachability edge. Transport retains
no additional Keiyaku diff blob or permanent ref solely to preserve a tender.

Terminal cleanup removes the delivery ref, candidate pin, and managed worktree.
Git pruning may then make a recorded predecessor or candidate unavailable.
That availability is transport state, while the delivery identities remain
durable contract facts. The public `Delivery.diff()` contract and its
transport-unavailable result are defined in [public-api.md](public-api.md).

No cleanup operation rewrites a target ref. A targetless claimed contract and a
targeted contract whose target later moves share the same byte-custody rule.
