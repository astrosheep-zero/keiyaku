# Public API

```ts
Keiyaku.bind({ repo: Repo.at(), markdown, target: "main" });
```

Keiyaku is the package-root contract library. It is ESM-only and the package
root is its sole public import surface. The public objects are `Keiyaku`,
`Repo`, `Delivery`, `World`, the shared `settings` resource constructor, their
exported errors, and the value types defined by their operations. `World` and
its branded `WorldRoot` coordinate are defined by [world.md](world.md).

## Composition Boundary

`src/library` is the package-root composition boundary. It validates
caller-shaped values, presents public handles and result values, and composes
capabilities by calling their concrete owner modules. It owns no persisted
authority, codec, storage mechanism, lifecycle judgment, selector grammar, or
physical Git, Task, or Akuma mechanism. A public operation may sequence owner
capabilities, but it does not restate their decisions or persist their facts.

Each public facet has one coherent module. `library/contract.ts` presents the
Contract handle and Contract operations, `library/repo.ts` presents the pinned
Git-world capability, and additional high-level facets remain separate from
both. `library/keiyaku.ts` only assembles the package-root exports and the
static `Keiyaku` facade. There is no generic orchestration layer, package-root
registry, or second authority behind that facade. Cross-product facts and
projections remain with their named concrete owners; the Library only exposes
their typed results.

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
invariant failures remain ordinary exceptions. Domain refusal throws
`KeiyakuRefused`; a terminal attempt that admitted no fact throws
`KeiyakuRetry`. Both carry a closed machine-readable code derived from their
single structured detail value.

## Construction And Scope

Settings construction and generic resource behavior are owned by
[settings.md](settings.md). This package root exports `settings`, `Settings`,
its observation value types, and the Contract-owned pure consumers
`gatesFrom({ settings, name? })`, `worktreeHooksFrom({ settings })`, and
`requireBranchesToBeUpToDateFrom({ settings })`. They
return concrete immutable values; no Contract operation reads a settings file
or retains a Settings observation. Their selected-entry and resource-view
failures throw the exported Contract-owned `SettingsError`; generic Settings
construction represents its own failures as scope and namespace states and
never produces that error.

`Repo.at` is the only public construction point for a Git world. Its public
surface is exactly:

```ts
type BindInput = Readonly<{
  repo: Repo
  markdown: string
  task?: TaskId
  target?: string
  workspace?: "worktree" | "here"
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
  hooks?: WorktreeHooks
}>

type HookCommand = Readonly<{
  argv: readonly string[]
  timeoutMs: number
}>

type WorktreeHooks = Readonly<{
  create: readonly HookCommand[]
  destroy: readonly HookCommand[]
}>

type ReconcileInput = Readonly<{
  hooks?: WorktreeHooks
  retryHooks?: boolean
}>

Repo.at(input?: { path?: string }): Repo
repo.root: string
repo.currentBranch(): Promise<string | null>
repo.reconcile(input?: ReconcileInput): Promise<RepoReconcileReport>
Keiyaku.of(input: { repo: Repo; id: ContractId }): Keiyaku
Keiyaku.bind(input: BindInput): Promise<BindResult>
Keiyaku.list(input: { repo: Repo }): Promise<ContractBoard>
Keiyaku.observe(input: { repo: Repo; id: ContractId }): Promise<ContractObservation>
```

`markdown` is the complete contract document and is decoded at the library
edge. `workspace` defaults to `"worktree"`. `task`, `target`, `workspace`, `actor`,
`after`, `gates`, and `hooks` are structured construction inputs. The edge mints opaque
document keys, while `gates` and `after` remain machine terms; their ownership
is defined by [document.md](document.md) and [lifecycle.md](lifecycle.md).

`task`, when present, is one complete `TaskId`. The Library composes the
Contract bind with the TaskHolder claim defined by [settlement.md](settlement.md)
in the same admission. It validates identity shape but does not require the
Task Markdown to exist before admission; a missing target Task is reported by
the mandatory settlement pass after the Contract has been admitted.

`actor` is caller-supplied testimony, not a registered identity. Package-root
inputs accept nonblank string bytes; the library validates and brands them as
the core `ActorId` before a journal write.

Core facts treat gate names as opaque words. The package-root `Gate` type is
`string`, with no public mint, brand, registry, or closed producer union. At
the JavaScript boundary, `bind` and `amend` require each element to match
`^[a-z][a-z0-9-]{0,63}$` and reject duplicates with a programmer `TypeError`.
`reviewed` and `verified` are conventional words, not privileged type members.
This surface does not infer what a custom word means or add a producer for it.
The deepest core `gateWord` predicate owns the lexical definition; Settings
consumption, public input admission, and persisted decoding each apply that one
definition at their own boundary.

`target` is a library-boundary input. A short input is validated with Git's
branch-name rules and then canonicalized to `refs/heads/<input>`. A full input
must be a valid `refs/heads/...` name. A Keiyaku-owned namespace is invalid in
either spelling. Invalid input returns the typed `invalid-target` refusal;
there is no DWIM resolution or coupling to the current branch. A valid target
must already exist when `bind` observes it. An absent branch returns the typed
`target-missing` refusal; Keiyaku never creates it or substitutes the caller's
current `HEAD`. The canonical full ref is the only target value persisted in
contract coordinates; its Git meaning is defined in
[git.md](git.md).

The one coupling is explicit `workspace: "here"`: when it also carries a
target, the caller worktree's symbolic branch must equal that canonical target.
A different or detached branch returns `here-target-mismatch` before Contract
birth. A later deliver from a here workspace rechecks the immutable coordinate;
`workspace-not-on-target` is a mechanical delivery refusal before a tender fact
when that branch moved. Both refusals report the expected target and observed
branch; `null` denotes detached HEAD. Targetless here remains valid.

`Repo.at` resolves and pins its repository coordinate before it returns. An
omitted `path` uses the caller's current working directory. The library has
exactly one `process.cwd()` call, in the private scope resolver used by
`Repo.at`. `Keiyaku.of` and `Keiyaku.bind` require that already-pinned `Repo`
capability; they accept neither a path nor an ambient repository default. No
raw scope, token, registry, or orchestrator is public. Instance operations
accept no repository coordinate.

`currentBranch()` observes the invocation worktree through that pinned Repo and
returns its canonical `refs/heads/...` symbolic `HEAD`, or `null` for detached
HEAD. It does not choose a target or change `Keiyaku.bind`'s explicit
targetless semantics; the CLI consumes this mechanical fact for its default.

`Repo` is the pinned Git-world capability. It owns reconciliation and the
coordinate needed by Contract operations, not Contract reads or construction.
`Keiyaku` is the sole branded Contract front door. There is no `repo.bind`,
`repo.status`, or `repo.contract` convenience path.

`Repo.at` resolves the enclosing Git world immediately and throws for a path
outside a repository. `root` is the resolved primary-worktree absolute path.
Different worktrees in the same Git world therefore address the same journal
while retaining the construction coordinate needed by `workspace: "here"`.
`Keiyaku.list` enumerates the Contract world; `Keiyaku.observe` performs one
targeted journal observation without enumerating it. Both project the same row
shape. The return contract and behavior of `reconcile` are defined by
[git.md](git.md).

`Keiyaku` has a private constructor. It is born only through `Keiyaku.of` or a
successful `Keiyaku.bind`, and is a stateless handle containing its contract
identity and the supplied Repo's pinned coordinate. These static operations do
not acquire repository scope. `Keiyaku` is not a repository registry, stored
authority, or second orchestrator. There is no alternate package-root contract
construction point.

```ts
type ContractGateCurrent =
  | Readonly<{ kind: "attested"; verdict: "satisfied" | "unsatisfied"; summary?: string }>
  | Readonly<{ kind: "stale"; priorVerdict: "satisfied" | "unsatisfied" }>
  | Readonly<{ kind: "missing" }>

type ContractGateReport = Readonly<{ gate: string; current: ContractGateCurrent }>

type DeliveryIdentity = Readonly<{
  tenderSnapshot: SnapshotId
  integration: Readonly<{
    predecessor: SnapshotId
    snapshot: SnapshotId
    changeId: ChangeId
  }>
  method: "squash"
  policy: Readonly<{ requireBranchesToBeUpToDate: boolean }>
}>

type ContractRow = Readonly<{
  id: ContractId
  phase: "waiting" | "bound" | "pending-delivery" | "claimed" | "abandoned"
  disposition: "active" | "terminal"
  workspace: "worktree" | "here"
  worktreePath: string | null
  target: string | null
  delivery: DeliveryIdentity | null
  targetObservation: Readonly<{
    head: SnapshotId | null
    drift: boolean
  }> | null
  gates: Readonly<{
    reports: readonly ContractGateReport[]
    satisfied: boolean
  }>
}>

type ContractBoard = Readonly<{
  root: string
  state: SnapshotId | null
  rows: readonly ContractRow[]
}>

type ContractObservation =
  | Readonly<{ kind: "missing"; id: ContractId }>
  | Readonly<{ kind: "present"; row: ContractRow }>
```

`state` is the immutable commit observed from `refs/heads/keiyaku-state` in the
same Git read that produced the rows. It is `null` when that ref is absent.
Lifecycle phase, disposition, candidate currency, every gate report, and the
aggregate `gates.satisfied` are interpreted only by the Contract read surface.
The aggregate calls the same core judgment as claimed admission. A stale prior
attestation and a never-attested gate remain distinct. Downstream boards and
renderers may present these discriminants but never re-evaluate them.

## Akuma Creation Facet

`library/akuma-creation.ts` is the package-root facet for operations that
produce a new AkuId. It composes Akuma creation with the concrete Dispatch and
Alias owners without moving any of those authorities into Library. Its public
operations are:

```ts
type CallInput = Readonly<{
  path: WorldRoot
  archetype: string
  body: string
  cwd?: string
  mode?: "wait" | "detach"
  timeoutMs?: number
  settings?: Settings
  contract?: Keiyaku
  alias?: AkumaAlias
}>

type ForkInput = Readonly<{
  path: WorldRoot
  akuma: string
  at: string
  settings?: Settings
  repo?: Repo
}>

Keiyaku.call(input: CallInput): Promise<CallResult>
Keiyaku.fork(input: ForkInput): Promise<ForkResult>
```

`path` is an already resolved WorldRoot; Library never climbs or normalizes it.
`cwd` is the optional execution cwd and defaults to that world for direct
library calls. The CLI always supplies its invocation cwd or the explicit
`--workdir` override. `mode` defaults to `"wait"`; wait mode observes the born handle
until it stops running or `timeoutMs`, which defaults to 300,000 milliseconds.
Detach mode returns after the post-birth integration stages and rejects a
supplied `timeoutMs` as contradictory caller input. `archetype` remains the TypeScript input name for
the Akuma-owned concept even though the CLI presents its positional as
`<akuma>`. `contract`, when present, must be a genuine package-root Keiyaku
handle and supplies both the complete ContractId and its already pinned Git
world. `repo` on fork is optional because an independent Akuma world may have
no Git world; when present it selects the one Dispatch authority to inspect and
propagate. `akuma` is one complete `AkuId` or Alias and is resolved once by the
Address facet before native fork. Neither operation invents a repository coordinate
or makes `Repo` an Akuma capability.

All caller-shaped values, including an optional Alias, are validated before
Akuma birth or native fork. Akuma owns call admission, birth, and native fork.
After a successful call, Library publishes Dispatch only when `contract` is
present, then moves Alias only when requested and Dispatch did not fail. A
contract-free call therefore remains a complete ordinary call and writes no
Dispatch. After a successful fork, Library reads the parent's Dispatch from
the supplied `repo`; when one exists it publishes the identical ContractId for
the child. Fork never inherits Alias.

```ts
type DispatchStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch }>
  | Readonly<{
      kind: "failed"
      failure: DispatchFailure | IntegrationFailure
    }>

type IntegrationFailure = Readonly<{
  kind: "authority-corruption" | "infrastructure"
  diagnostic: string
}>

type AliasStage =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "aliased"; alias: AliasBinding; previous: AkuId | null }>
  | Readonly<{ kind: "skipped"; reason: "dispatch-failed" }>
  | Readonly<{ kind: "failed"; failure: IntegrationFailure }>

type CallObservation =
  | Readonly<{ kind: "detached" }>
  | Readonly<{ kind: "observed"; status: AkumaStatus }>
  | Readonly<{ kind: "failed"; failure: IntegrationFailure }>

type CallResult = Readonly<{
  kind: "called"
  akuma: AkuId
  dispatch: DispatchStage
  alias: AliasStage
  observation: CallObservation
}>

type ForkResult =
  | Readonly<{ kind: "forked"; parent: AkuId; child: AkuId; dispatch: DispatchStage }>
  | Readonly<{ kind: "provider-cannot-fork"; parent: AkuId; provider: string }>
  | Readonly<{ kind: "unknown-history"; parent: AkuId; at: string }>
  | Readonly<{ kind: "fork-failed"; parent: AkuId; diagnostic: string }>
  | Readonly<{
      kind: "upstream-forked"
      parent: AkuId
      childSession: ResumeCoordinate
      diagnostic: string
    }>
```

The top-level Akuma result reports the irreversible Akuma fact first. Once an
Akuma was born or forked, a later Dispatch, Alias, or call observation failure stays inside its
closed stage and never becomes a naked rejection or rollback. A Dispatch
failure prevents a requested Alias move and produces `skipped`; an Alias
failure preserves the completed Dispatch. Observation still runs after either
integration stage because those stages do not stop the born Akuma. A call
failure before birth and a
native fork refusal retain the Akuma-owned error or receipt unchanged. Library
does not retry an owner result, store a receipt, or add another association
decision. `IntegrationFailure` exists only after an irreversible Akuma result:
it preserves an owner exception's category and verbatim diagnostic so the
already born child remains visible. The same exception before birth or native
fork retains the ordinary package-root exception behavior.

## Akuma Address And Fleet Facets

`library/address.ts` is the sole package-root selector expansion facet.
Complete AkuIds and Alias select one Akuma. Set operations additionally accept
Akuma globs and complete ContractIds; a Contract selector expands immutable
Dispatch facts against one supplied Repo. Set expansion first parses every
selector, then reads each required owner at most once: compact fleet for globs,
Alias map for aliases, and the supplied Repo's Dispatch set for Contract
selectors. An unused or failed product cannot suppress an exact selector. It unions
duplicates, and returns AkuIds in byte order. Dispatch membership does not
depend on compact-fleet visibility; a corrupt skipped member therefore remains
an addressed worker and its operation reports its own failure. An empty set,
unknown Alias, invalid selector, or Contract selector without a Repo is caller
input failure. Akuma remains unaware of Alias, Dispatch, Contract, glob, and
Repo.

`library/fleet.ts` composes only public Akuma handles after that expansion:

```ts
Keiyaku.status(input: AkumaAddressInput): AkumaStatus
Keiyaku.tell(input: AkumaTellInput): Promise<AkumaTellResult>
Keiyaku.interrupt(input: AkumaInterruptInput): Promise<AkumaInterruptResult>
Keiyaku.history(input: AkumaHistoryInput): AkumaHistoryResult
Keiyaku.wait(input: AkumaWaitInput): Promise<AkumaWaitResult>
Keiyaku.kill(input: AkumaSetAddressInput): Promise<AkumaKillResult>
```

Wait and kill freeze their subject set at entry. A one-member wait defaults to
`all`; a multi-member wait requires `completion: "any" | "all"`. Any returns
after one member satisfies the ordinary Akuma wait predicate; all returns after
every member does. Timeout returns one complete aggregate of fresh statuses
and is not a streaming or partial result. Kill returns one evidence member per
selected AkuId in the same stable order. Tell returns its receipt with the one
subsequent public status observation. Direct verbs accept only AkuId or Alias.
Their result carries the resolved AkuId, so an adapter never resolves a movable
Alias twice. `history({ last: true })` is the distinct last-answer arm: it reads
only the last answered turn and never reads status or activity history.

`library/catalog.ts` owns the shallow package-root catalog:

```ts
Keiyaku.ls(input: CatalogInput): Promise<Catalog>
```

`CatalogInput` carries `path: WorldRoot | null`, one Settings snapshot, and an
optional already resolved Repo. A null world makes Task and Akuma sections
absent without creating a marker; an absent Repo makes the Contract section
absent. Catalog performs no path or Git discovery.

It independently lists the Task world, Contract board, Archetype names, and
compact Akuma fleet. Every section is present, absent, or failed; one section
cannot suppress another. An optional exact Contract, exact AkuId, or `@name`
selector is adjudicated by `library/address.ts` and filters the corresponding
catalog. When `@name` names both an active
Contract short reference and an Akuma Alias, selection fails explicitly as
ambiguous. `ls` performs no Kanshi joins and no activity/history reads.

## Contract Operations

```ts
keiyaku.state(): Promise<ContractState>
keiyaku.delivery(): Promise<Delivery | null>
keiyaku.amend(input: {
  markdown: string
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
  hooks?: WorktreeHooks
}): Promise<AmendResult>
keiyaku.deliver(input?: {
  actor?: ActorId
  message?: string
  requireBranchesToBeUpToDate?: boolean
  hooks?: WorktreeHooks
}): Promise<MutationResult<Delivery>>
keiyaku.review(input: {
  verdict: AttestationVerdict
  actor?: ActorId
  summary?: string
  hooks?: WorktreeHooks
}): Promise<MutationResult<Review>>
keiyaku.abandon(input?: {
  actor?: ActorId
  note?: string
  hooks?: WorktreeHooks
}): Promise<MutationResult<void>>
keiyaku.arc(input: { markdown: string; actor?: ActorId; hooks?: WorktreeHooks }): Promise<MutationResult<void>>
keiyaku.audit(input?: { actor?: ActorId; hooks?: WorktreeHooks }): Promise<MutationResult<AuditReport>>
keiyaku.reconcile(input?: ReconcileInput): Promise<ReconcileReport>

delivery.diff(): Promise<string | null>
```

`state()` observes and folds afresh for each call. Worktree paths are projected
by `status()` for selectors and board views; a contract handle has no duplicate
path getter.

`amend` takes an H2 operation document, and `arc` takes an arc document. Their
input grammars are owned by [document.md](document.md). `deliver`, `review`,
`abandon`, and `audit` apply the lifecycle rules in
[lifecycle.md](lifecycle.md). `reconcile` requests the Git operation
defined in [git.md](git.md). `ReconcileReport` is that chapter's
exact `ReconcileResult`, including its flat cleanup lag; this chapter does not
define a second result shape.

Every accepted mutation makes one mandatory reconciliation attempt with the
supplied `hooks`, if any. Omitting them means empty commands only when Git must
freeze a marker for a worktree that has no marker; it never replaces commands
already frozen in that marker. `retryHooks` exists only on explicit reconcile,
is a boolean programmer input, and retries a stored failed phase with its
frozen commands. No mutation input carries `retryHooks`, so an ordinary later
mutation cannot silently retry a failed external command.

`review` is a contract operation. It does not require a Delivery handle or an
existing delivery fact. It captures the current worktree's integration-aware
ChangeId and the document key projected by its lifecycle observation. It
receives no decoded-document derivation. It records the owned `reviewed`
testimony even when that token is absent from `terms.gates`.

`delivery()` freshly observes the journal and returns the most recent tender.
It returns `null` only when the contract has never tendered. A returned
Delivery exposes the tender snapshot and the complete integration identity;
`deliver()` and `delivery()` are its two birth paths. A Delivery has no review
operation. `message` overrides only a mechanically
materialized commit message; omitting it uses the Git template in
[git.md](git.md).

## Mutation Results And Errors

Protocol owns its internal three-arm outcome and uses it only to compose an
invocation. The package root does not export that control-flow structure.
Library is the sole public facade: it projects accepted protocol outcomes into
success values, throws typed pre-admission domain failures, and performs the
mandatory post-admission Git reconciliation and settlement before
returning. Post-admission failure is reported as lag without hiding or
rejecting the admitted Contract. CLI calls this same facade; it does not
interpret protocol outcomes or repeat either follow-up stage.

`MutationResult` is invocation-scoped observation, never Contract state or a
durable receipt. `facts` and `head` come only from accepted protocol admission.
`effects` and `lags` first contain any physical result produced inside targeted
placement's Git fence, then the one mandatory Git reconciliation; `settlement`
comes only from the one settlement invocation. There is no nested `receipt`,
duplicate fact field, or result stored on a `Keiyaku` handle.

```ts
type KeiyakuRetryReason =
  | Readonly<{ kind: "exhausted" }>
  | Readonly<{ kind: "collision" }>
  | Readonly<{
      kind: "publication-failed"
      diagnostic: string
    }>

type MutationResult<A> = Readonly<{
  facts: readonly Fact[]
  head: ContractHead
  value: A
  effects: readonly TopologyEffect[]
  lags: readonly Lag[]
  settlement: SettlementReport
}>

class KeiyakuRefused extends Error {
  readonly refusal: KeiyakuRefusal
  readonly code: KeiyakuRefusal["kind"] // derived getter over refusal.kind
}

class KeiyakuRetry extends Error {
  readonly reason: KeiyakuRetryReason
  readonly code: KeiyakuRetryReason["kind"] // derived getter over reason.kind
}

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

type BindResult = Readonly<
  Omit<MutationResult<Keiyaku>, "value"> &
  { keiyaku: Keiyaku } &
  RegionObservation
>

type AmendResult = Readonly<
  MutationResult<void> &
  RegionObservation &
  { documentDiff: string }
>

type StepStop<R> = Readonly<
  | { refusal: R; retry?: never }
  | { retry: KeiyakuRetryReason; refusal?: never }
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

type IntegrationRefusal = Readonly<{
  kind: "integration-failed"
  contractId: ContractId
  reason: "not-based-on-target" | "unrelated-histories" | "conflict"
  targetHead: SnapshotId
  conflictPaths?: readonly string[]
}> | Readonly<{
  kind: "integration-unsupported"
  contractId: ContractId
  requiredGit: "2.38"
}>

type CheckoutNotFollowableRefusal = Readonly<{
  kind: "checkout-not-followable"
  contractId: ContractId
  target: string
  path: string
  reason: "staged" | "conflict" | "untracked"
  paths: readonly string[]
}>

type DeliveryWorkspaceRefusal = Readonly<{
  kind: "workspace-not-on-target"
  contractId: ContractId
  target: string
  branch: string | null
}>

type DocumentMovedRefusal = Readonly<{
  kind: "document-moved"
  contractId: ContractId
}>

type TargetInputRefusal =
  | Readonly<{ kind: "invalid-target" }>
  | Readonly<{ kind: "target-missing" }>
  | Readonly<{
      kind: "here-target-mismatch"
      target: string
      branch: string | null
    }>

type VerificationStop =
  | StepStop<AttestationRefusal>
  | Readonly<{ failure: "candidate-unavailable"; diagnostic: string }>
  | Readonly<{ failure: "timeout" | "unknown-exit" }>
  | Readonly<{ failure: "spawn-error"; diagnostic: string }>

type PlacementStop =
  | StepStop<PlacementRefusal | CheckoutNotFollowableRefusal | DeliveryWorkspaceRefusal>
  | Readonly<{
      failure: "target-moved"
      contractId: ContractId
      target: string
      expected: SnapshotId
      observed: SnapshotId | null
    }>
  | Readonly<{ failure: "target-placement-failed"; diagnostic: string }>

type Delivery = Readonly<{
  tenderSnapshot: SnapshotId
  integration: Readonly<{
    predecessor: SnapshotId
    snapshot: SnapshotId
    changeId: ChangeId
  }>
  method: "squash"
  policy: Readonly<{ requireBranchesToBeUpToDate: boolean }>
  verification?: VerificationStop
  placement?: PlacementStop
  leak?: WorktreeLeak
  diff(): Promise<string | null>
}>

type Review = Readonly<{
  placement?: PlacementStop
}>
```

`RegionObservation` is structural notation for successful `bind` and `amend`
results, not another package-root export. Exactly one property is present.
`overlaps`, including `[]`, means the observation completed. `overlapFailure`
means admission succeeded but the non-authoritative observation did not
complete; it contains the verbatim diagnostic and does not change the mutation
result. `RegionOverlap` is the only exported Region result type.

The Region report remains a library-edge observation. It is not passed to
protocol, core, or Git, and it never crosses those layers as Region
vocabulary. After admission, the library makes one internal protocol document
read. That read observes Git once, folds every contract, filters
terminal contracts, and returns only `{ contract, documentBytes }`; it neither
decodes a document nor names Region. The library removes self, decodes the
opaque peer bytes through the same body methodology, and computes overlap at
the edge. It never imports Git directly, loops over per-contract `state()`
reads, reuses an admission receipt as a world snapshot, or caches or persists a
second Region value.

`amend` exposes `terms-moved` when any source `ContractTerms` value used to
derive its complete replacement no longer matches the attempt observation.
`deliver` and audit's read-only methodology selection expose
`DocumentMovedRefusal` for their key-stamped document derivation. Review receives no decoded-document
derivation and does not expose `document-moved`; its testimony remains keyed to
the subject actually reviewed. `KeiyakuRefusal` therefore includes
`terms-moved` for amend, `DocumentMovedRefusal` for deliver and audit, and
`DeliveryWorkspaceRefusal` for a here deliver whose caller workspace left its
target. That refusal ends the invocation; it does not trigger a reread,
auto-retry, or adoption of a new document revision.

`TargetInputRefusal` is the `KeiyakuRefusal` member for `Keiyaku.bind` target
validation, existence, and the targeted-here branch relationship. It has no
contract coordinate because a rejected target establishes no contract
identity.

Every accepted `AmendResult` includes its nonoptional `documentDiff`. The
library computes it exactly once with the JavaScript `diff` package from the
exact whole-document before and after bytes. It is presentation data only: it
is not document-body law, a journal fact, a receipt, cache state, or a gate
input, and it does not cross below the library boundary.

Every successful mutation result contains every fact admitted by that
invocation and the resulting contract-head scalar. Successful Verification attestation and
placement therefore appear only in `facts`; their named stop channels are
absent. Package-root results expose no `Receipt`, `prior`, or folded `snapshot`.
Protocol may retain prior and snapshot values while composing one invocation,
but they are process-local implementation data with no public or persistent
reader.

An unsuccessful trailing obligation does not change the successful leading act.
The `verification` or `placement` channel contains the typed reason why that
obligation admitted no fact. Verification process outcomes and attestation
admission stops share `VerificationStop`; placement admission stops use
`PlacementStop`. The obligations are independent and both channels may be
present on one Delivery. A channel is absent exactly when its obligation was
not applicable or admitted its fact; callers distinguish those cases through
`facts`. These values remain process-local and non-authoritative; the journal
is the sole lifecycle authority.

`KeiyakuRefused` stores the complete structured `KeiyakuRefusal`; its `code`
getter derives from `refusal.kind`. `KeiyakuRetry` does the same for
`KeiyakuRetryReason`. The getters are not second stored discriminants. Callers
can switch exhaustively on `code` and inspect the structured value when the
refusal carries a contract coordinate or the retry carries a diagnostic.
Programmer value-shape errors and authority corruption retain their distinct
exception types.

`KeiyakuRefused` and `KeiyakuRetry` remain reserved for invocations that
admitted no fact. Recoverable post-admission physical and settlement failures
are visible in the successful result's typed lags. The facade never abandons
an admitted Contract as error recovery.

Retry details are process-local and non-authoritative. Exhaustion and canonical
entry collisions carry no admission, contract, journal, or byte payload. A
known failed atomic transaction carries only `publication-failed` and its
verbatim diagnostic. It does not claim which asserted ref moved; a later
invocation prepares from a fresh observation.

Result identity has one source. A successful bind names the born Contract only
through `keiyaku` and its facts; later mutation results address the handle the
caller already owns. A refusal carries a contract identity only when its
structured refusal concerns an existing contract. A retry never carries
contract identity: it asserts that no new identity was established, and
retrying bind mints a new identity. Adapters keep their addressed input instead
of mining another coordinate from an error.

```ts
type AuditReport = Readonly<{
  reworks: number
  reviews: number
  timeline: readonly TimelineEntry[]
  delivery?: DeliveryIdentity
  targetObservation?: Readonly<{ head: SnapshotId | null; drift: boolean }>
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
summary from that fact. Reports include the current delivery identity and
fresh target observation when available, but no journal entries, body snapshots,
detached raw logs, artifacts, or evidence bytes.

`audit()` returns `MutationResult<AuditReport>` when its leading observation and
mandatory reconciliation complete. A read-only audit and any Verification stop
remain a successful result with zero facts. A successful Verification
attestation appears in `facts`; a process nonterminal or attestation
refusal/retry appears in `report.attempt`. A leading refusal or retry, such as a
missing contract, uses the same `KeiyakuRefused` or `KeiyakuRetry` rejection as
every other public mutation. None of these cases creates a second observation
authority or duplicate boolean flag.

Verification may use one process-local disposable worktree. Failure to remove
it after a fact was admitted cannot change the accepted arm, facts, or exit
status. `Delivery.leak` and `AuditReport.leak` report that physical residue with
its path and verbatim diagnostic. They are transient reports, not journal
facts, cleanup authority, or reconcile input.

## Delivery Diff

`Delivery.diff()` asks Git to resolve the pinned integration predecessor and
integration snapshot identities each time. It returns their diff text when both bytes are
available, including `""` for an empty patch. It returns `null` when Git
cannot resolve either recorded byte sequence, including a pruning race during
the lookup. It never exposes a raw Git lookup error. The complete integration
identity and `tenderSnapshot` remain available on the Delivery in either result.

Diff text is presentation data. It is never persisted, folded, admitted,
cached, supplied to a gate, or retained through a Keiyaku-owned ref. Terminal
cleanup may release delivery refs, candidate pins, and managed worktrees only
under the Git-owned cleanup rule; byte availability remains Git
custody. The CLI renders a `null` result for
`--show-diff-body` as
`{ reason: "git-unavailable", integrationSnapshot, changeId }`, without a raw Git
diagnostic and with observation exit status `0`.

## Document Boundary

Document decoding and amendment are internal library work. Public callers pass
Markdown to the construction and amendment operations above. The library owns
the Keiyaku Markdown methodology at this edge and may expose only the opaque
document keys needed by core. It does not expose a structured `ContractBody`, a
render function, a Git handle, direct journal writer, placement operation,
or verification-run operation.

The package root exports the operation value names `Delivery` and `Review`.
`DeliverValue`, `ReviewValue`, and `ReviewResult` are not public aliases.

Contract-to-Task association is the TaskHolder fact owned by
[settlement.md](settlement.md), never a Task Markdown field. The package-root
facade composes holder changes into bind and abandon admission, then reaches
Task writes only through the sole post-admission coordinator. Core Contract
decisions and Git admission do not interpret Task coordinates or Task
lifecycle. The separate task subpath shipped in this package neither imports
package-root values nor observes, validates, writes, or folds Contract facts.

## Akuma Subpath

`./akuma` is a separate product subpath and imports no Contract or Git
domain. Its identity, construction, exported values, handle capabilities, and
result behavior are owned only by [akuma.md](akuma.md); this package-root
chapter does not duplicate that law. Its `Akuma.call` and handle `fork` remain
the pure Contract-free Akuma capabilities. The package-root Akuma facet above
is the only higher-level composition and does not create a second Akuma
mechanism.
