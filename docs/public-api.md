# Public API

```ts
Repo.at().bind({ markdown, target: "main" });
```

Keiyaku is the package-root contract library. It is ESM-only and the package
root is its sole public import surface. The public objects are `Keiyaku`,
`Repo`, `Delivery`, and the exported value types defined by their operations.

Every package-root domain operation that accepts input takes exactly one
readonly object. Public operations have no positional value parameters and no
positional-value-plus-options overloads. A genuinely inputless operation keeps
`()`; private pure value functions are outside this package-root law.

At the JavaScript boundary, validation always accepts `unknown` input and
returns the validated domain or branded value. A caller is never required to
pre-brand a runtime value, and an implementation does not cast an unvalidated
record back into a narrower domain type. Validation is performed once at the
owning package boundary; no schema framework or parallel validation model is
part of the surface.

Caller value-shape and Markdown errors throw `TypeError` before repository
observation, including when an addressed contract does not exist. Persisted
authority that cannot be decoded or legally folded throws the exported
`AuthorityCorruptionError`. Other unexpected infrastructure and private
invariant failures remain ordinary exceptions; none is converted into an
`Outcome` arm.

## Construction And Scope

`Repo.at` is the only public construction point for a Git world. Its public
surface is exactly:

```ts
type BindInput = Readonly<{
  markdown: string
  target?: string
  workspace?: "worktree" | "here"
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
}>

Repo.at(input?: { path?: string }): Repo
repo.root: string
repo.contract(input: { id: ContractId }): Keiyaku
repo.bind(input: BindInput): Promise<BindResult>
repo.status(input?: { contract?: ContractId }): Promise<StatusReport>
repo.reconcile(): Promise<RepoReconcileReport>
```

`markdown` is the complete contract document and is decoded at the library
edge. `workspace` defaults to `"worktree"`. `target`, `workspace`, `actor`,
`after`, and `gates` are structured construction inputs. The edge mints opaque
document keys, while `gates` and `after` remain machine terms; their ownership
is defined by [document.md](document.md) and [lifecycle.md](lifecycle.md).

`actor` is caller-supplied testimony, not a registered identity. Package-root
inputs accept nonblank string bytes; the library validates and brands them as
the core `ActorId` before a journal write.

`Gate` is the closed package-root union `"reviewed" | "verified"`; it has no
public mint or opaque brand. At the JavaScript boundary, `bind` and `amend`
validate every `gates` element and throw a programmer `TypeError` for an
unknown or duplicate token. Widening this union requires the same change to add a
satisfiable attestation producer path on this package-root surface; a token is
never admitted on the promise of a future producer.

`target` is a library-boundary input. A short input is validated with Git's
branch-name rules and then canonicalized to `refs/heads/<input>`. A full input
must be a valid `refs/heads/...` name. A Keiyaku-owned namespace is invalid in
either spelling. Invalid input returns the typed `invalid-target` refusal;
there is no DWIM resolution or coupling to the current branch. A valid target
must already exist when `bind` observes it. An absent branch returns the typed
`target-missing` refusal; Keiyaku never creates it or substitutes the caller's
current `HEAD`. The canonical full ref is the only target value persisted in
contract coordinates; its transport meaning is defined in
[transport.md](transport.md).

`Repo.at` resolves and pins its repository coordinate before it returns. An
omitted `path` uses the caller's current working directory. The library has
exactly one `process.cwd()` call, in the private scope resolver used by
`Repo.at`. `repo.contract` and `repo.bind` reuse that one private
`PinnedScope`; no raw scope, token, registry, or orchestrator is public.
Instance operations accept no repository coordinate.

`Repo` is the pinned Git-world view. Its contract-birth operations are
`repo.contract` and `repo.bind`; the complete public surface is listed above.

`Repo.at` resolves the enclosing Git world immediately and throws for a path
outside a repository. `root` is the resolved primary-worktree absolute path.
Different worktrees in the same Git world therefore address the same journal
while retaining the construction coordinate needed by `workspace: "here"`.
Status without input is a world aggregation: it enumerates contract identities
and projects each contract state with its computed worktree path. A supplied
`contract` performs one targeted journal observation and returns zero or one
row in the same `StatusReport`; it does not enumerate the world first. The
return contract and behavior of `reconcile` are defined by
[transport.md](transport.md).

`Keiyaku` has a private constructor. It is born only through
`repo.contract` or a successful `repo.bind`, and is a stateless handle
containing its contract identity and pinned coordinate. It is not a repository
registry, stored authority, or second orchestrator. There is no alternate
package-root construction point.

```ts
type ContractStatus = Readonly<{
  contractId: ContractId
  phase: "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned"
  workspace: "worktree" | "here"
  worktreePath: string | null
  target: string | null
  verification: null | Readonly<{
    verdict: "satisfied" | "unsatisfied"
    summary?: string
  }>
}>

type StatusReport = Readonly<{
  scope: string
  contracts: readonly ContractStatus[]
}>

```

## Contract Operations

```ts
keiyaku.state(): Promise<ContractState>
keiyaku.delivery(): Promise<Delivery | null>
keiyaku.amend(input: {
  markdown: string
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
}): Promise<AmendResult>
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

`state()` observes and folds afresh for each call. Worktree paths are projected
by `status()` for selectors and board views; a contract handle has no duplicate
path getter.

`amend` takes an H2 operation document, and `arc` takes an arc document. Their
input grammars are owned by [document.md](document.md). `deliver`, `review`,
`abandon`, and `audit` apply the lifecycle rules in
[lifecycle.md](lifecycle.md). `reconcile` requests the transport operation
defined in [transport.md](transport.md). `ReconcileReport` is that chapter's
exact `ReconcileResult`, including its flat cleanup lag; this chapter does not
define a second result shape.

`review` is a contract operation. It does not require a Delivery handle or an
existing delivery fact. It captures the current worktree patch identity against
the contract start and the document key projected by its lifecycle observation.
It receives no decoded-document derivation. It records the owned `reviewed`
testimony even when that token is absent from `terms.gates`.

`delivery()` freshly observes the journal and returns the most recent tender.
It returns `null` only when the contract has never tendered. A returned
Delivery is pinned to public `snapshotId`, `changeId`, and
`expectedPredecessor`; `deliver()` and `delivery()` are its two birth paths. A
Delivery has no review operation. `message` overrides only a mechanically
materialized commit message; omitting it uses the transport template in
[transport.md](transport.md).

## Outcomes And Reports

The three-arm outcome union has one structural definition in protocol. The
package root re-exports that definition as `Outcome`; its only library-side
type operation is to intersect presentation observations into the accepted
arm. Refused and retry arms pass through unchanged, and accepted-value mapping
may replace only `value`. `TypedRefusal` is a direct alias of protocol's
`IntentRefusal`, never a duplicate or widened union. No shared-types module or
second outcome definition exists.

```ts
type TypedRetry =
  | Readonly<{ kind: "exhausted" }>
  | Readonly<{ kind: "collision" }>
  | Readonly<{
      kind: "publication-failed"
      diagnostic: string
    }>

type Outcome<A, Observation extends object = Record<never, never>> =
  | ({
      kind: "accepted"
      facts: readonly Fact[]
      head: ContractHead
      value: A
    } & Observation)
  | { kind: "refused"; refusal: TypedRefusal }
  | { kind: "retry"; reason: TypedRetry }

type WorktreeLeak = Readonly<{
  path: string
  diagnostic: string
}>

export type RegionOverlap = Readonly<{
  contract: ContractId
  patterns: readonly Readonly<{ mine: string; theirs: string }>[]
}>

type RegionObservation = Readonly<
  | { overlaps: readonly RegionOverlap[]; overlapFailure?: never }
  | { overlapFailure: string; overlaps?: never }
>

type BindResult = Outcome<Keiyaku, RegionObservation>

type AmendResult = Outcome<
  void,
  RegionObservation & Readonly<{ documentDiff: string }>
>

type StepStop<R> = Readonly<
  | { refusal: R; retry?: never }
  | { retry: TypedRetry; refusal?: never }
>

type AttestationRefusal = Readonly<{
  kind: "contract-missing" | "terminal"
  contractId: ContractId
}>

type AmendRefusal = Readonly<{
  kind:
    | "contract-missing"
    | "terminal"
    | "terms-moved"
    | "prerequisites-already-consumed"
    | "unknown-prerequisite"
    | "cyclic-prerequisite"
  contractId: ContractId
}>

type PlacementRefusal = Readonly<{
  kind: "contract-missing" | "delivery-missing" | "terminal" | "gates-unsatisfied"
  contractId: ContractId
}>

type DocumentMovedRefusal = Readonly<{
  kind: "document-moved"
  contractId: ContractId
}>

type TargetInputRefusal =
  | Readonly<{ kind: "invalid-target" }>
  | Readonly<{ kind: "target-missing" }>

type VerificationStop =
  | StepStop<AttestationRefusal>
  | Readonly<{ failure: "candidate-unavailable"; diagnostic: string }>
  | Readonly<{ failure: "timeout" | "unknown-exit" }>
  | Readonly<{ failure: "spawn-error"; diagnostic: string }>

type PlacementStop = StepStop<PlacementRefusal>

type Delivery = Readonly<{
  snapshotId: SnapshotId
  changeId: ChangeId
  expectedPredecessor: SnapshotId
  verification?: VerificationStop
  placement?: PlacementStop
  leak?: WorktreeLeak
  diff(): Promise<string | null>
}>

type Review = Readonly<{
  placement?: PlacementStop
}>
```

`RegionObservation` is structural notation for the accepted arms of `bind` and
`amend`, not another package-root export. Exactly one property is present.
`overlaps`, including `[]`, means the observation completed. `overlapFailure`
means admission succeeded but the non-authoritative observation did not
complete; it contains the verbatim diagnostic and does not change the accepted
outcome. `RegionOverlap` is the only exported Region result type.

The Region report remains a library-edge observation. It is not passed to
protocol, core, or transport, and it never crosses those layers as Region
vocabulary. After admission, the library makes one internal protocol document
read. That read observes the carrier once, folds every contract, filters
terminal contracts, and returns only `{ contract, documentBytes }`; it neither
decodes a document nor names Region. The library removes self, decodes the
opaque peer bytes through the same body methodology, and computes overlap at
the edge. It never imports carrier directly, loops over per-contract `state()`
reads, reuses an admission receipt as a world snapshot, or caches or persists a
second Region value.

`amend` exposes `terms-moved` when any source `ContractTerms` value used to
derive its complete replacement no longer matches the attempt observation.
`deliver` and audit's read-only methodology selection expose
`DocumentMovedRefusal` for their key-stamped document derivation. Review receives no decoded-document
derivation and does not expose `document-moved`; its testimony remains keyed to
the subject actually reviewed. `TypedRefusal` therefore includes
`terms-moved` for amend and `DocumentMovedRefusal` for deliver and audit. That
refusal ends the invocation; it does not trigger a reread, auto-retry, or
adoption of a new document revision.

`TargetInputRefusal` is the `TypedRefusal` member for `repo.bind` target
validation and existence. It has no contract coordinate because a rejected
target establishes no contract identity.

Every accepted `AmendResult` includes its nonoptional `documentDiff`. The
library computes it exactly once with the JavaScript `diff` package from the
exact whole-document before and after bytes. It is presentation data only: it
is not document-body law, a journal fact, a receipt, cache state, or a gate
input, and it does not cross below the library boundary.

An accepted outcome contains every fact admitted by that invocation and the
resulting contract-head scalar. Successful Verification attestation and
placement therefore appear only in `facts`; their named stop channels are
absent. Package-root outcomes expose no `Receipt`, `prior`, or folded `snapshot`.
Protocol may retain prior and snapshot values while composing one invocation,
but they are process-local implementation data with no public or persistent
reader.

An unsuccessful trailing obligation does not change the outer accepted outcome.
The `verification` or `placement` channel contains the typed reason why that
obligation admitted no fact. Verification process outcomes and attestation
admission stops share `VerificationStop`; placement admission stops use
`PlacementStop`. The obligations are independent and both channels may be
present on one Delivery. A channel is absent exactly when its obligation was
not applicable or admitted its fact; callers distinguish those cases through
`facts`. These values remain process-local and non-authoritative; the journal
is the sole lifecycle authority.
Programmer value-shape errors throw; domain refusals and carrier races use the
closed `Outcome` union.

Retry details are process-local and non-authoritative. Exhaustion and canonical
entry collisions carry no admission, contract, journal, or byte payload. A
known failed atomic transaction carries only `publication-failed` and its
verbatim diagnostic. It does not claim which asserted ref moved; a later
invocation prepares from a fresh observation.

Outcome identity has one source per arm. An accepted result carries the
contract born or addressed by its value, facts, and head. A refusal carries a
contract identity only when its typed refusal concerns an existing contract.
A retry never carries contract identity: it asserts that no new identity was
established, and retrying bind mints a new identity. A caller addressing an
existing contract already owns that coordinate and adapters use that input;
they do not mine a second identity from an outcome.

```ts
type AuditReport = Readonly<{
  reworks: number
  reviews: number
  timeline: readonly TimelineEntry[]
  attempt?: VerificationStop
  leak?: WorktreeLeak
}>

type TimelineEntry = Readonly<{
  kind: FactKind
  at: string
  sincePrior: number | null
  attestation?: Readonly<{
    gate: string
    verdict: "satisfied" | "unsatisfied"
    summary?: string
  }>
}>
```

`reworks` counts `deliver` facts and `reviews` counts attestations emitted by
the review operation. Timeline entries are in journal order; `at` is copied from the fact and `sincePrior` is
the integer millisecond difference from the immediately preceding value. The
first entry yields `null`; a negative difference is preserved. Canonical
journal decoding rejects an unparseable timestamp before this projection.
Attestation timeline entries copy their gate, verdict, and optional bounded
summary from that fact. Reports contain no journal entries, body snapshots,
detached raw logs, artifacts, or evidence bytes.

`audit()` always returns `Outcome<AuditReport>`. Its leading act is the report
observation, so a read-only audit and any Verification stop remain accepted with
zero facts. A successful Verification attestation appears in `facts`; a process
nonterminal or attestation refusal/retry appears in `report.attempt`. Audit's
top-level refused/retry arms come only from its leading observation, such as a
missing contract. None of these cases creates a second observation authority or
duplicate boolean flag.

Verification may use one process-local disposable worktree. Failure to remove
it after a fact was admitted cannot change the accepted arm, facts, or exit
status. `Delivery.leak` and `AuditReport.leak` report that physical residue with
its path and verbatim diagnostic. They are transient reports, not journal
facts, cleanup authority, or reconcile input.

## Delivery Diff

`Delivery.diff()` asks transport to resolve the pinned predecessor and
candidate identities each time. It returns their diff text when both bytes are
available, including `""` for an empty patch. It returns `null` when transport
cannot resolve either recorded byte sequence, including a pruning race during
the lookup. It never exposes a raw Git lookup error. `snapshotId` and
`changeId` remain available on the Delivery in either result.

Diff text is presentation data. It is never persisted, folded, admitted,
cached, supplied to a gate, or retained through a Keiyaku-owned ref. Terminal
cleanup may release delivery refs, candidate pins, and managed worktrees only
under the transport-owned cleanup rule; byte availability remains transport
custody. The CLI renders a `null` result for
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
