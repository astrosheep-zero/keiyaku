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

The Library is the package-root composition boundary. It validates
caller-shaped values, presents public handles and result values, and composes
capabilities by calling their concrete owner modules. It owns no persisted
authority, codec, storage mechanism, lifecycle judgment, selector grammar, or
physical Git, Task, or Akuma mechanism. A public operation may sequence owner
capabilities, but it does not restate their decisions or persist their facts.

Contract operations, pinned Git-world capability, Akuma composition, addressing,
fleet operations, and catalog remain coherent public facets. The static
`Keiyaku` facade only assembles them. There is no generic orchestration layer,
package-root registry, or second authority behind that facade. Cross-product
facts and projections remain with their named concrete owners; the Library
only exposes their typed results.

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

Repo.at(input?: { path?: string }): Promise<Repo>
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

`Repo.at` asynchronously resolves and pins its repository coordinate before it
returns. An omitted `path` uses the caller's current working directory. The
library has
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

## Contract Operations

```ts
keiyaku.state(): Promise<ContractState>
keiyaku.guidance(): Promise<string>
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
  includeDirty?: boolean
  signal?: AbortSignal
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
keiyaku.audit(input?: { actor?: ActorId; signal?: AbortSignal; hooks?: WorktreeHooks }): Promise<MutationResult<AuditReport>>
keiyaku.reconcile(input?: ReconcileInput): Promise<ReconcileReport>

delivery.diff(): Promise<string | null>
```

`deliver` uses a clean-workspace default. `includeDirty: true` explicitly
authorizes the complete non-ignored staged, unstaged, and untracked final tree;
it does not select only staged paths and never includes dirty submodule
internals. Omission and `false` are identical. Git performs the capture without
changing the caller's real `HEAD`, index, branch, or files.

When a delivery or audit runs Verification, the library materializes the
integration snapshot into a private scratch worktree and derives its worktree
commands from that snapshot's tracked project Settings. Caller Settings and
`node_modules` are not public inputs to this operation. An environment that
cannot become ready returns the typed Verification stop from
[public-results.md](public-results.md) and admits no attestation; declaration
timeouts are instead unsatisfied attestation facts. Caller cancellation is a
nonterminal stop and admits no attestation.

`state()` and `guidance()` observe and fold afresh for each call. `guidance()`
returns the canonical derived bytes owned by [workspace.md](workspace.md).
Worktree paths are projected
by `status()` for selectors and board views; a contract handle has no duplicate
path getter.

`amend` takes an H2 operation document, and `arc` takes an arc document. Their
input grammars are owned by [document.md](document.md). `deliver`, `review`,
`abandon`, and `audit` apply the lifecycle rules in
[lifecycle.md](lifecycle.md). `reconcile` requests the Git operation
defined in [git-reconciliation.md](git-reconciliation.md). `ReconcileReport`
is that chapter's exact `ReconcileResult`, including its flat cleanup lag; this
chapter does not define a second result shape.

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
testimony even when that token is absent from `terms.gates`. If the observed
projection includes ordinary dirty workspace bytes, `Review` exposes a
`workspace` disclosure with staged, unstaged, untracked, and `shortStat` fields;
that disclosure is not testimony and does not authorize delivery.

`delivery()` freshly observes the journal and returns the most recent tender.
It returns `null` only when the contract has never tendered. A returned
Delivery exposes the tender snapshot and the complete integration identity;
`deliver()` and `delivery()` are its two birth paths. A Delivery has no review
operation. `message` overrides only a mechanically materialized commit message;
omitting it uses the Git template in [git.md](git.md).

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
domain. Its identity and birth are owned by [akuma.md](akuma.md), and its
exported values and handle capabilities by [akuma-public.md](akuma-public.md); this package-root
chapter does not duplicate that law. Its `Akuma.call` and handle `fork` remain
the pure Contract-free Akuma capabilities. The package-root Akuma facet above
is the only higher-level composition and does not create a second Akuma
mechanism.
