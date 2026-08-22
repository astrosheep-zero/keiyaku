# Public API

```ts
Keiyaku.bind({ repo: await Repo.at(), markdown, target: "main" });
```

Keiyaku is published as the public ESM-only npm package
`@astrosheep/keiyaku@4.0.0`. The package root is its sole public Contract
import surface, with `@astrosheep/keiyaku/task`,
`@astrosheep/keiyaku/kanshi`, and `@astrosheep/keiyaku/akuma` as its named
product exports. There is no old package-name compatibility export. The public
package-root objects are `Keiyaku`,
`Repo`, `Delivery`, `World`, the shared `settings` resource constructor, their
exported errors, and the value types defined by their operations. `World` and
its branded `WorldRoot` coordinate are defined by [world.md](world.md).

## Composition Boundary

The Library validates caller values, presents public handles/results, and
composes concrete owner capabilities. It owns no persisted authority, codec,
lifecycle judgment, selector grammar, or physical Git, Task, or Akuma
mechanism. The static `Keiyaku` facade assembles coherent Contract and Akuma
facets without a generic orchestrator, registry, second authority, or copied
decision.

Every package-root domain operation that accepts input takes exactly one
readonly object. Public operations have no positional value parameters and no
positional-value-plus-options overloads. A genuinely inputless operation keeps
`()`; private pure value functions are outside this package-root law.

Any package-root operation that observes filesystem, SQLite, process, or Git
state is asynchronous. Its Promise fulfills only after the owned observation
and any ordered physical effect have completed. Pure parsing, identity math,
value projection, and handle construction over already resolved coordinates
remain synchronous; no constructor or getter hides external observation, and
there is no synchronous compatibility surface.

JavaScript validation accepts `unknown` and returns a domain or branded value;
callers never pre-brand. The owning package boundary validates once, with no
parallel validation model in the public surface.

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
their observation values, and the Contract-owned consumers
`gatesFrom({ settings, names? })`, `worktreeHooksFrom({ settings })`, and
`requireBranchesToBeUpToDateFrom({ settings })`. They return immutable values;
Contract operations retain no Settings observation, and Git receives only the
opaque hook value. Selected-entry and resource-view failures throw
`SettingsError`; generic Settings construction instead returns scope and
namespace states.

`Repo.at` is the only public construction point for a Git world. Its public
surface is exactly:

```ts
type MarkdownBindInput = Readonly<{
  repo: Repo
  markdown: string
  task?: TaskId
  target?: string
  workspace?: "worktree"
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
  hooks?: WorktreeHooks
}>

type ForkBindInput = Readonly<{
  repo: Repo
  forkOf: ContractId
  target?: string
  workspace?: "worktree"
  actor?: ActorId
  hooks?: WorktreeHooks
}>

type BindInput = MarkdownBindInput | ForkBindInput

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

Repo.at(input?: { path?: string; gitPath?: string }): Promise<Repo>
repo.root: string

`ForkBindInput` is a closed, disjoint bind form. It reads the named source's
current folded terms and exact original start snapshot, changes only its H1 to
`Fork · <source title>`, and admits an ordinary fresh Contract. It has no
Markdown, Task, gate, or prerequisite input. Its only overrides are target and
workspace placement; target otherwise copies the source target and workspace
defaults to managed worktree. A source may be active or abandoned, but missing,
corrupt, unfoldable, or unavailable-start sources refuse. The source relation is
not persisted.
repo.currentBranch(): Promise<string | null>
repo.reconcile(input?: ReconcileInput): Promise<RepoReconcileReport>
Keiyaku.of(input: { repo: Repo; id: ContractId }): Keiyaku
Keiyaku.bind(input: BindInput): Promise<BindResult>
Keiyaku.list(input: { repo: Repo }): Promise<ContractBoard>
Keiyaku.observe(input: { repo: Repo; id: ContractId }): Promise<ContractObservation>
Keiyaku.nuke(input: NukeInput): Promise<NukeResult>
```

```ts
type NukeInput = Readonly<{
  world: WorldRoot
  confirm?: string
}>

```

The result union is owned by [public-results.md](public-results.md). The
confirmation and reset semantics are owned by [world.md](world.md).

`markdown` is the complete contract document and is decoded at the library
edge. `workspace` defaults to `"worktree"` and admits only that value. `task`,
`target`, `workspace`, `actor`, `after`, `gates`, and `hooks` are structured
construction inputs. The edge mints opaque document keys, while `gates` and
`after` remain machine terms; their ownership is defined by
[document.md](document.md) and [lifecycle.md](lifecycle.md).

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

An omitted target requires a real `HEAD` commit; an unborn `HEAD` returns the
typed `unborn-head` refusal.

`Repo.at` resolves and pins the Git world before returning; omitted `path` uses
the caller cwd. Optional nonblank `gitPath` selects and pins the executable for
every Git subprocess issued through that Repo; omission uses the literal
executable `git`. The string is an executable coordinate, not a repository path,
and is passed to process creation unchanged. `currentBranch()` returns the invocation worktree's canonical
symbolic branch or `null`, without choosing a target. `Keiyaku.of` and
`Keiyaku.bind` require that Repo; instance operations accept no repository
coordinate, and no raw scope, token, registry, or orchestrator is public.

The `@astrosheep/keiyaku/kanshi` surface additionally exports the optional
read-time `KanshiInput.region` selection and typed `RegionRead` values. The
selection and read unions have exactly three arms: world declarations, one
active Contract with grouped counterpart overlaps, and one or more query
patterns with grouped overlaps. This is a current active-document read using
the document Region owner; it is not persisted and is independent of delivery
or audit paths.
`Repo.at` throws outside a repository; `root` is the primary-worktree absolute
path, so its worktrees share one journal.
`Keiyaku.list` enumerates the active Contract world from one Git observation
and samples `observedAt` with that observation. `Keiyaku.observe` performs one
targeted journal observation without enumerating the world. Both project the
same row shape, including declared `after` edges. Reverse `dependents` require
the complete active board, so a targeted observe leaves `dependents` empty.
Selected status constructs that complete board, then selects; it is not a
targeted observe. The return contract and behavior of `reconcile` are defined by
[git-reconciliation.md](git-reconciliation.md).

`Keiyaku` is a stateless branded handle born only through `Keiyaku.of` or a
successful bind. There is no `Repo` convenience path or alternate constructor.

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

type ContractTargetLag =
  | Readonly<{ kind: "counted"; behind: number }>
  | Readonly<{ kind: "unknown" }>
  | Readonly<{ kind: "none" }>
type ContractWorkspaceLocation = Readonly<{ kind: "worktree"; path: string }>
type ContractWorkspaceMerge = Readonly<{
  head: SnapshotId
  unmergedPaths: readonly string[]
}>
type ContractWorkspaceObservation =
  | Readonly<{ kind: "clean" | "dirty"; location: ContractWorkspaceLocation; counts: Readonly<{ staged: number; unstaged: number; untracked: number; submodules: number }>; merge: ContractWorkspaceMerge | null }>
  | Readonly<{ kind: "unavailable"; location: ContractWorkspaceLocation }>
  | Readonly<{ kind: "unappointed" }>
  | Readonly<{ kind: "failed"; diagnostic: string }>

type ContractPhase = "waiting" | "bound" | "tendered" | "claimed" | "abandoned"
type AfterEndpointObservation =
  | Readonly<{ kind: "claimed" }>
  | Readonly<{ kind: "active"; phase: ContractPhase }>
  | Readonly<{ kind: "abandoned" }>
  | Readonly<{ kind: "missing" }>
type ContractAfterEdge = Readonly<{
  contractId: ContractId
  endpoint: AfterEndpointObservation
}>
type ContractDependent = Readonly<{
  contractId: ContractId
  phase: ContractPhase
}>

type ContractRow = Readonly<{
  id: ContractId
  title: string | null
  phase: ContractPhase
  phaseAt: string
  lastJournalAt: string
  disposition: "active" | "terminal"
  workspace: "worktree"
  worktreePath: string | null
  workspaceObservation: ContractWorkspaceObservation
  target: string | null
  targetLag: ContractTargetLag
  delivery: DeliveryIdentity | null
  targetObservation: Readonly<{ head: SnapshotId | null; drift: boolean }> | null
  gates: Readonly<{ reports: readonly ContractGateReport[]; satisfied: boolean }>
  after: readonly ContractAfterEdge[]
  dependents: readonly ContractDependent[]
}>

type ContractBoard = Readonly<{
  root: string
  state: SnapshotId | null
  observedAt: string
  rows: readonly ContractRow[]
}>

type ContractObservation =
  | Readonly<{ kind: "missing"; id: ContractId }>
  | Readonly<{ kind: "present"; row: ContractRow }>
```

`state` is the same-read `refs/heads/keiyaku-state` commit, or `null` when
absent. `observedAt` is sampled with that Git observation. Title is the current
document H1. `targetLag` counts workspace `HEAD`
against the same-epoch `targetObservation.head` and never rereads a live
target ref. `workspaceObservation` is a Git read-time fact, not a journal
field. Clean and dirty arms carry `merge: null` or `{ head, unmergedPaths }`
from `MERGE_HEAD` and ordered unmerged index paths; unavailable, unappointed,
and failed arms fabricate no merge field. An unappointed managed Contract uses
the `unappointed` arm,
keeps `worktreePath` null, and is not probed as a worktree. `after` preserves
declared edges in terms order. `dependents` reverse only active board rows and
sort lexically by complete ContractId. Phase,
disposition, candidate currency, every gate report, and `gates.satisfied` use
the claimed-admission judgment. Downstream boards copy them and never
re-evaluate them. JSON retains full Git object IDs. Text may abbreviate only
Git object IDs — `state`, tender snapshot, integration predecessor/snapshot,
target HEAD, and merge head — with unique prefixes, minimum 7 and lengthened as
required. ChangeId, ContractId, EntryUlid, TaskId, and AkuId remain complete.
The generic `failed { diagnostic: string }` arm reports workspace-appointment
authority corruption or an unreadable workspace fact without a new refusal.
Its diagnostic is bounded text and has no structured path field. Mutating
pre-admission paths and nonterminal reconciliation instead throw
`AuthorityCorruptionError`.

## Contract Operations

```ts
keiyaku.state(): Promise<ContractState>
keiyaku.guidance(): Promise<string>
keiyaku.history(): Promise<ContractHistory>
keiyaku.delivery(): Promise<Delivery | null>
keiyaku.amend(input: {
  markdown?: string
  actor?: ActorId
  after?: readonly ContractId[]
  gates?: readonly Gate[]
  hooks?: WorktreeHooks
}): Promise<AmendResult>
keiyaku.deliver(input?: {
  actor?: ActorId
  message?: string
  requireBranchesToBeUpToDate?: boolean
  includeDirty?: boolean
  materializeConflict?: boolean
  signal?: AbortSignal
  hooks?: WorktreeHooks
}): Promise<MutationResult<Delivery> | IntegrationConflictMaterialized>
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
keiyaku.audit(input?: {
  actor?: ActorId;
  includeDirty?: boolean;
  showDiff?: boolean;
  requireBranchesToBeUpToDate?: boolean;
  signal?: AbortSignal;
  hooks?: WorktreeHooks;
}): Promise<MutationResult<AuditReport>>
keiyaku.reconcile(input?: ReconcileInput): Promise<ReconcileReport>

delivery.diff(): Promise<string | null>
```

`deliver` and `audit` default to a clean workspace; `includeDirty` authorizes
the complete non-ignored final tree, not a staged-path selection. Omission is
the same as `false`. `materializeConflict` is false by default and can return
`IntegrationConflictMaterialized`; its conflict and recovery rules belong to
[lifecycle.md](lifecycle.md). Audit has no message or materialization input;
`showDiff` includes the requested candidate diff and scope, including `""`.
Akuma forwarding and Verification retain their owning protocol boundaries.

`state()` and `guidance()` observe and fold afresh. `history()` returns typed
journal and Dispatch events from one observation; its ordering and failures are
owned by [model.md](model.md).

```ts
type ContractHistoryEvent =
  | Readonly<{ source: "journal"; fact: Fact }>
  | Readonly<{ source: "dispatch"; dispatch: Dispatch }>

type ContractHistory = Readonly<{
  id: ContractId
  state: SnapshotId
  events: readonly ContractHistoryEvent[]
}>
```

Worktree paths are projected
by `status()` for selectors and board views; a contract handle has no duplicate
path getter.

`amend` requires `markdown`, `after`, or `gates`; its grammar and document diff
belong to [document.md](document.md). Omitted terms remain unchanged and empty
arrays replace theirs. Lifecycle operations use [lifecycle.md](lifecycle.md),
and reconciliation uses [git-reconciliation.md](git-reconciliation.md).

`review` does not require a Delivery and records its `reviewed` testimony before
trailing placement. Dirty-workspace disclosure is not testimony or delivery
authorization. Its Akuma permission is independent of `contract.deliver`.

`delivery()` freshly returns the most recent tender or `null`. A Delivery exposes
its tender and integration identities, has no review operation, and uses the
Git-owned message template when `message` is omitted.

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
custody. The CLI renders a `null` Delivery.diff result as
`{ reason: "git-unavailable", integrationSnapshot, changeId }`, without a raw Git
diagnostic and with observation exit status `0`. Audit never uses that
unavailable arm: `--diff` either omits `candidate.diff` or retains the exact
requested bytes, including `""`.

## Document Boundary

Document decoding and amendment are internal library work. Public callers pass
Markdown to the construction and amendment operations above. The library owns
the Keiyaku Markdown methodology at this edge and may expose only the opaque
document keys needed by core. It does not expose a structured body, a
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
domain. Its identity and birth are owned by [akuma.md](akuma.md), and its
exported values and handle capabilities by [akuma-public.md](akuma-public.md); this package-root
chapter does not duplicate that law. Its `Akuma.call` and handle `fork` remain
the pure Contract-free Akuma capabilities. The package-root Akuma facet above
is the only higher-level composition and does not create a second Akuma
mechanism.
