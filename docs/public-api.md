# Public API

```ts
Keiyaku.bind({ markdown, target: "main" });
```

Keiyaku is the package-root contract library. It is ESM-only and the package
root is its sole public import surface. The public objects are `Keiyaku`,
`Repo`, `Delivery`, and the exported value types defined by their operations.

Every package-root domain operation that accepts input takes exactly one
readonly object. Public operations have no positional value parameters and no
positional-value-plus-options overloads. A genuinely inputless operation keeps
`()`; private pure value functions are outside this package-root law.

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
Keiyaku.of(input: { id: ContractId; repo?: string }): Keiyaku
```

`markdown` is the complete contract document and is decoded at the library
edge. `workspace` defaults to `"worktree"`. `target`, `workspace`, `actor`,
`after`, and `gates` are structured construction inputs. The edge mints opaque
document keys, while `gates` and `after` remain machine terms; their ownership
is defined by [document.md](document.md) and [lifecycle.md](lifecycle.md).

`actor` is caller-supplied testimony, not a registered identity. Package-root
inputs accept nonblank string bytes; the library validates and brands them as
the core `ActorId` before a journal write.

Each construction point resolves and pins its repository coordinate before it
returns a contract handle. An omitted `repo` uses the caller's current working
directory. The library has exactly one `process.cwd()` call, in the shared
private scope resolver used by the construction points and `Repo.at`. Instance
operations accept no repository coordinate.

`Repo` is the pinned Git-world view. Its public surface is exactly:

```ts
Repo.at(input?: { path?: string }): Repo
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
}): Promise<Outcome<void, RegionObservation>>
keiyaku.deliver(input?: {
  actor?: ActorId
  message?: string
}): Promise<Outcome<Delivery>>
keiyaku.review(input: {
  verdict: AttestationVerdict
  actor?: ActorId
  summary?: string
}): Promise<Outcome<Review>>
keiyaku.abandon(input?: {
  actor?: ActorId
  note?: string
}): Promise<Outcome<void>>
keiyaku.arc(input: { markdown: string; actor?: ActorId }): Promise<Outcome<void>>
keiyaku.audit(input?: { actor?: ActorId }): Promise<Outcome<AuditReport>>
keiyaku.reconcile(): Promise<ReconcileReport>

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

`review` is a contract operation. It does not require a Delivery handle or an
existing delivery fact. It captures the current worktree patch identity against
the contract start and the effective document key. It records the owned
`reviewed` testimony even when that token is absent from `terms.gates`.

`delivery()` freshly observes the journal and returns the most recent tender.
It returns `null` only when the contract has never tendered. A returned
Delivery is pinned to public `snapshotId`, `changeId`, and
`expectedPredecessor`; `deliver()` and `delivery()` are its two birth paths. A
Delivery has no review operation. `message` overrides only a mechanically
materialized commit message; omitting it uses the transport template in
[transport.md](transport.md).

## Outcomes And Reports

```ts
type Outcome<A, Observation extends object = Record<never, never>> =
  | ({ kind: "accepted"; receipt: Receipt; value: A } & Observation)
  | { kind: "refused"; refusal: TypedRefusal }
  | { kind: "retry"; reason: TypedRetry }

export type RegionOverlap = Readonly<{
  contract: ContractId
  patterns: readonly Readonly<{ mine: string; theirs: string }>[]
}>

type RegionObservation = Readonly<
  | { overlaps: readonly RegionOverlap[]; overlapFailure?: never }
  | { overlapFailure: string; overlaps?: never }
>

type BindResult = Outcome<Keiyaku, RegionObservation>

type Receipt = Readonly<{
  facts: readonly Fact[]
  prior: ContractState | null
  snapshot: ContractState
}>

type StepStop<R> = Readonly<
  | { refusal: R; retry?: never }
  | { retry: TypedRetry; refusal?: never }
>

type AttestationRefusal = Readonly<{
  kind: "contract-missing" | "terminal"
  contractId: ContractId
}>

type PlacementRefusal = Readonly<{
  kind: "contract-missing" | "delivery-missing" | "terminal" | "gates-unsatisfied"
  contractId: ContractId
}>

type VerificationAttempt = Readonly<{
  failure: "timeout" | "spawn-error" | "unknown-exit"
}>

type Delivery = Readonly<{
  snapshotId: SnapshotId
  changeId: ChangeId
  expectedPredecessor: SnapshotId
  verification?: StepStop<AttestationRefusal>
  placement?: StepStop<PlacementRefusal>
  attempt?: VerificationAttempt
  diff(): Promise<string | null>
}>

type Review = Readonly<{
  placement?: StepStop<PlacementRefusal>
}>
```

`RegionObservation` is structural notation for the accepted arms of `bind` and
`amend`, not another package-root export. Exactly one property is present.
`overlaps`, including `[]`, means the observation completed. `overlapFailure`
means admission succeeded but the non-authoritative observation did not
complete; it contains the verbatim diagnostic and does not change the accepted
outcome. `RegionOverlap` is the only exported Region result type.

After successful admission, the library obtains every nonterminal contract's
opaque document from one internal protocol read and applies the body dialect to
those bytes. It compares the already-decoded input against those peer documents
and adds the observation at the public edge. The protocol read performs one
immutable carrier observation; the library never loops over per-contract state
reads or imports carrier. Region is not passed to protocol or core, cached, or
persisted separately from the document that declared it.

An accepted receipt contains every fact admitted by that invocation. Successful
auto-verification and auto-placement therefore appear only in `receipt.facts`;
their named value fields are absent.

An unsuccessful incidental admission does not change the outer accepted
outcome. Its `verification` or `placement` field contains exactly one mutually
exclusive `refusal` or `retry` property. The wrapper has no `kind`
discriminator and is private implementation vocabulary; only its instantiated
Delivery and Review shapes are public. A runtime `timeout`, `spawn-error`, or
`unknown-exit` admits no fact and appears only as transient `attempt`. When a
step neither lands nor leaves a stop or attempt, its fields are absent. These
values remain process-local and non-authoritative; the journal is the sole
lifecycle authority.
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

`reworks` counts `deliver` facts and `reviews` counts attestations emitted by
the review operation. Timeline entries are in journal order; `at` is copied from the fact and `sincePrior` is
the integer millisecond difference from the immediately preceding value. The
first, an unparseable pair, or a missing prior value yields `null`; a negative
difference is preserved. Reports contain no journal entries, body snapshots,
raw logs, artifacts, or evidence bytes.

`audit()` always returns `Outcome<AuditReport>`. The report describes
observation; any receipt describes only the same invocation's process-local
return. A read-only audit, a timeout, a spawn failure, or another no-fact report
does not create a second observation authority or duplicate boolean flag.

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

## Document Boundary

Document decoding and amendment are internal library work. Public callers pass
Markdown to the construction and amendment operations above. The library owns
the Keiyaku Markdown methodology at this edge and may expose only the opaque
document keys needed by core. It does not expose a structured `ContractBody`, a
render function, a carrier handle, direct journal writer, placement operation,
or verification-run operation.

The package root exports the operation value names `Delivery` and `Review`.
`DeliverValue`, `ReviewValue`, and `ReviewResult` are not public aliases.

Task products may retain a returned `ContractId` and observe terminal contract
state through this API. Their association, persistence, failure policy, and
mutations are their own authority; the contract library has no task coordinate
or settlement effect.
