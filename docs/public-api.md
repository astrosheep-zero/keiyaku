# Public API

```ts
Keiyaku.bind({ markdown, target: "main" });
```

Keiyaku is the package-root contract library. It is ESM-only and the package
root is its sole public import surface. The public objects are `Keiyaku`,
`Repo`, `Delivery`, and the `ContractBody` type with its `render` function.

## Construction And Scope

`Keiyaku` owns the two construction points:

```ts
type BindInput = Readonly<{
  markdown: string
  repo?: string
  target?: string
  workspace?: "worktree" | "here"
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
}>

Keiyaku.bind(input: BindInput): Promise<BindResult>
Keiyaku.of(id: ContractId, options?: { repo?: string }): Keiyaku
```

`markdown` is the complete contract document and is decoded at the
construction boundary. `workspace` defaults to `"worktree"`. `target`,
`workspace`, `actor`, `after`, and `gates` are structured construction inputs;
their document and lifecycle rules live in [document.md](document.md) and
[lifecycle.md](lifecycle.md).

Each construction point resolves and pins its repository coordinate before it
returns a contract handle. An omitted `repo` uses the caller's current working
directory. The library has exactly one `process.cwd()` call, in the shared
private scope resolver used by the construction points and `Repo.at`. Instance
operations accept no repository coordinate.

`Repo` is the pinned Git-world view. Its public surface is exactly:

```ts
Repo.at(path?: string): Repo
repo.root: string
repo.status(): Promise<StatusReport>
repo.reconcile(): Promise<RepoReconcileReport>
```

`Repo.at` resolves the enclosing Git world immediately and throws for a path
outside a repository. `root` is the resolved primary-worktree absolute path.
Different worktrees in the same Git world therefore address the same journal
while retaining the construction coordinate needed by `workspace: "here"`.
`status` is a world aggregation: it enumerates contract identities and projects
each contract state with its computed worktree path. The return contract and
behavior of `reconcile` are defined by [transport.md](transport.md).

```ts
type ContractStatus = Readonly<{
  contractId: ContractId
  phase: "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned"
  terminal: "claimed" | "abandoned" | null
  workspace: "worktree" | "here" | null
  worktreePath: string | null
  target: string | null
}>

type StatusReport = Readonly<{
  scope: string
  contracts: readonly ContractStatus[]
}>

```

`Keiyaku` has a private constructor. It is a stateless handle containing its
contract identity and pinned coordinate, not a repository registry, stored
authority, or second orchestrator.

## Contract Operations

```ts
keiyaku.state(): Promise<ContractState>
keiyaku.delivery(): Promise<Delivery | null>
keiyaku.worktreePath: string | null
keiyaku.amend(input: {
  markdown: string
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
}): Promise<Outcome<void>>
keiyaku.deliver(options?: { actor?: ActorId }): Promise<Outcome<Delivery>>
keiyaku.abandon(reason: AbandonReason, options?: {
  actor?: ActorId
  note?: string
}): Promise<Outcome<void>>
keiyaku.arc(input: { markdown: string; actor?: ActorId }): Promise<Outcome<void>>
keiyaku.audit(options?: { actor?: ActorId }): Promise<Outcome<AuditReport>>
keiyaku.reconcile(): Promise<ReconcileReport>

delivery.review(verdict: ReviewVerdict, options?: {
  actor?: ActorId
  summary?: string
}): Promise<Outcome<void>>
delivery.diff(): Promise<string | null>
```

`state()` observes and folds afresh for each call. `worktreePath` is a computed
property: a contract declaring `workspace: "worktree"` has its deterministic
delivery-worktree path, while a `here` contract has `null`. The property is a
projection for callers such as the CLI selector; it is not a stored fact.

`amend` takes an H2 operation document, and `arc` takes an arc document. Their
input grammars are owned by [document.md](document.md). `deliver`, `review`,
`abandon`, and `audit` apply the lifecycle rules in
[lifecycle.md](lifecycle.md). `reconcile` requests the transport operation
defined in [transport.md](transport.md).

`delivery()` freshly observes the journal and returns the most recent tender.
It returns `null` only when the contract has never tendered. A returned
Delivery is pinned to public `snapshotId` and `changeId`; `deliver()` and
`delivery()` are its two birth paths. `review()` records judgment about that
Delivery's patch identity. A terminal contract receives the verb's typed
terminal refusal from the lifecycle decision.

## Outcomes And Reports

```ts
type Outcome<A> =
  | { kind: "accepted"; receipt: Receipt; value: A }
  | { kind: "refused"; refusal: TypedRefusal }
  | { kind: "retry"; reason: TypedRetry }

type Receipt = Readonly<{
  facts: readonly Fact[]
  prior: ContractState | null
  snapshot: ContractState
}>
```

Accepted writing operations return the facts admitted by their winning
decision, the folded predecessor that supplied that decision, and its
post-admission fold. `prior` is process-local receipt data. It is neither
persisted state nor an additional authority. A bind receipt has `prior: null`.
Programmer value-shape errors throw; domain refusals and carrier races use the
closed `Outcome` union.

```ts
type AuditReport = Readonly<{
  reworks: number
  reviews: number
  timeline: readonly TimelineEntry[]
  attempt?: Readonly<{
    failure: "timeout" | "spawn-error" | "unknown-exit"
  }>
}>

type TimelineEntry = Readonly<{
  kind: FactKind
  at: string
  sincePrior: number | null
}>
```

`reworks` counts `deliver` facts and `reviews` counts `review` facts. Timeline
entries are in journal order; `at` is copied from the fact and `sincePrior` is
the integer millisecond difference from the immediately preceding value. The
first, an unparseable pair, or a missing prior value yields `null`; a negative
difference is preserved. Reports contain no journal entries, body snapshots,
raw logs, artifacts, or evidence bytes.

`audit()` always returns `Outcome<AuditReport>`. When it admits a Verification
fact, that fact is in `receipt.facts`; a read-only audit, a timeout, a spawn
failure, or another no-fact report is an accepted outcome with an empty receipt
fact list. The report describes observation and the receipt describes
admission. There is no second observation union or duplicate boolean flag.

## Delivery Diff

`Delivery.diff()` asks transport to resolve the pinned predecessor and
candidate identities each time. It returns their diff text when both bytes are
available, including `""` for an empty patch. It returns `null` when transport
cannot resolve either recorded byte sequence, including a pruning race during
the lookup. It never exposes a raw Git lookup error. `snapshotId` and
`changeId` remain available on the Delivery in either result.

Diff text is presentation data. It is never persisted, folded, admitted,
cached, supplied to a gate, or retained through a Keiyaku-owned ref. Terminal
cleanup may remove delivery refs, candidate pins, and managed worktrees; byte
availability remains transport custody. The CLI renders a `null` result for
`--show-diff-body` as
`{ reason: "transport-unavailable", snapshotId, changeId }`, without a raw Git
diagnostic and with observation exit status `0`.

## ContractBody And Boundary

`ContractBody` is an exported readonly value type. Its only public operation
is canonical rendering:

```ts
ContractBody.render(body: ContractBody, options?: {
  currentArc?: ArcChapter
}): string
```

Document decoding and amendment are internal library work. Public callers pass
Markdown to the construction and amendment operations above. The package does
not expose a carrier handle, direct journal writer, placement operation, or
verification-run operation.

Task products may retain a returned `ContractId` and observe terminal contract
state through this API. Their association, persistence, failure policy, and
mutations are their own authority; the contract library has no task coordinate
or settlement effect.
