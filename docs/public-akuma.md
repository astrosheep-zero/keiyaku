# Public Akuma Facets

This chapter owns package-root Akuma creation, addressing, fleet, and cross-product composition.

## Observation

All Akuma observations expose the same typed timeline snapshot. Mutation
receipts and the fresh observation remain separate values, while status, wait,
call, tell, interrupt, and kill use the same semantic rows. Snapshot selection
pins the current frontier, latest outcome, open Turn, and pending tell; it does
not add a derived lifecycle fact.

Every filesystem, Alias, Dispatch, and Heart observation in these facets is
awaited before the public Promise fulfills. Composition preserves the declared
stage order; asynchronous observation does not introduce parallel writers,
cached resolution, or a background integration queue.

## Akuma Creation Facet

The Akuma creation facet is the package-root owner for operations that produce
a new AkuId. It composes Akuma creation with the concrete Dispatch and
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
  home?: string
  settings?: Settings
  contract?: Keiyaku
  alias?: AkumaAlias
}>

type ForkInput = Readonly<{
  path: WorldRoot
  akuma: string
  at: string
  repo?: Repo
}>

Keiyaku.call(input: CallInput): Promise<CallResult>
Keiyaku.fork(input: ForkInput): Promise<ForkResult>
```

`path` is an already resolved WorldRoot; Library never climbs or normalizes it.
Optional `home` is the Archetype coordinate and is never inferred from Settings
provenance; omission uses `~/.keiyaku`. Settings remains the provider snapshot.
`cwd` is the optional execution cwd. Explicit input is canonicalized; an
omitted Contract-free value uses the WorldRoot. With a Contract and no cwd,
Library accepts only an active managed workspace and uses the workspace
owner's Place appointment. It never derives, allocates, releases, creates, or
reconciles a Place or worktree. An unavailable Contract workspace refuses
before birth with no cwd fallback; appointment failures identify `reconcile`
as the repair entry. `mode` defaults to `"wait"`; wait mode observes the born handle
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
the child. Fork never inherits Alias. Fork remains an optional provider
capability: Library invokes it only when the source provider offers the
operation and the requested Turn owns an exact point. It never manufactures a
substitute.

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
  readonly?: ReadonlyRestraint
  execution: Readonly<{
    cwd: string
    source: "input" | "world" | "contract-worktree"
  }>
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
`CallResult.readonly` and its observed `AkumaStatus.readonly` project the same
Soul fact. Library neither judges realization nor constructs a second warning
or capability value. `execution` records the canonical cwd used for birth and
exactly one source. It adds no second path, Place, boolean, or Contract field.

## Akuma Address And Fleet Facets

The Address facet is the sole package-root selector expansion owner.
Complete AkuIds and Alias select one Akuma. Set operations additionally accept
Akuma globs and complete ContractIds; a Contract selector expands immutable
Dispatch facts against one supplied Repo. Set expansion first parses every
selector, then reads each required owner at most once: compact fleet for globs,
Alias map for aliases, and the supplied Repo's Dispatch set for Contract
selectors. An unused or failed product cannot suppress an exact selector. It unions
duplicates, and returns AkuIds in byte order. Dispatch membership does not
depend on compact-fleet visibility; a corrupt skipped member therefore remains
an addressed worker and its operation reports its own failure. After that union,
every member introduced by a `kei/...` selector is checked in the invocation
World (`path`). An Akuma absent from that World refuses the whole frozen set
with `AkumaWorldScopeError` before wait or kill starts. The refusal is
`{ kind: "akuma-not-in-world", ids, world }`: it names the selected World and
those AkuIds and does not claim where they live. A corrupt Heart keeps its
existing diagnostic and is not relabeled as that refusal. A direct `aku/...`
selector that is absent keeps `AkumaNotBornError`. A `kei/...` selector
requires `repo`, reads Dispatch only from that Repo, and never scans another
World or silently drops a Dispatch member. An empty set,
unknown Alias, invalid selector, or Contract selector without a Repo is caller
input failure. Akuma remains unaware of Alias, Dispatch, Contract, glob, and
Repo.

The Fleet facet composes only public Akuma handles after that expansion:

```ts
Keiyaku.status(input: AkumaAddressInput): Promise<AkumaObservation>
Keiyaku.tell(input: AkumaTellInput): Promise<AkumaTellResult>
Keiyaku.interrupt(input: AkumaInterruptInput): Promise<AkumaInterruptResult>
Keiyaku.history(input: AkumaHistoryInput): Promise<AkumaHistoryResult>
Keiyaku.wait(input: AkumaWaitInput): Promise<AkumaWaitResult>
Keiyaku.kill(input: AkumaSetAddressInput): Promise<AkumaKillResult>
```

```ts
type CreatedTaskObservation =
  | Readonly<{ kind: "present"; rows: readonly TaskRow[] }>
  | Readonly<{ kind: "failed"; diagnostic: string }>;

type AkumaObservation = Readonly<{
  status: AkumaStatus;
  contractId?: ContractId;
  createdTasks: CreatedTaskObservation;
}>;

type AkumaWaitResult = Readonly<{
  completion: "any" | "all";
  observations: readonly AkumaObservation[];
}>;

type AkumaTellResult = {
  akuma: AkuId;
  tell: TellResult;
  observation: AkumaObservation;
};

type AkumaInterruptResult = {
  id: AkuId;
  receipt:
    | { kind: "interrupted"; putDown: "was-idle" | "self-aborted"; tell: TellResult }
    | { kind: "unavailable"; evidence: "hung" | "untidy" | "unavailable" };
  observation: AkumaObservation;
};

type AkumaKillResult = {
  results: readonly {
    id: AkuId;
    evidence: KillEvidence;
    observation: AkumaObservation;
  }[];
};
```

The optional `repo` coordinate enables this read-only Dispatch composition.
`status` is always the unmodified Akuma observation; the optional neighboring
`contractId` comes only from Dispatch. `createdTasks` are the current Task
rows whose parsed `createdBy` equals `status.id` by exact string bytes. Do not
parse `createdBy` as AkuId, authenticate it, normalize it, or infer it from
namespace, Dispatch, cwd, Git author, TaskHolder, or later Task mutations.
Missing `createdBy` does not match. Manual testimony remains authoritative
under existing Task law. A successful Task read with no matches is
`{ kind: "present", rows: [] }`. Task authority corruption or infrastructure
failure becomes `{ kind: "failed", diagnostic }` and never suppresses an Akuma
status, Dispatch association, mutation receipt, kill evidence, or another
member. Each direct status or single-member mutation first obtains its existing
fresh Akuma status, then performs one Task board observation. Multi-member wait
performs no Task read during its polling loop; once the existing completion
predicate or timeout selects the final statuses, it reads the Task board
exactly once and projects every member from that same board snapshot.
Multi-member kill likewise reads the Task board once for all post-action
observations. There is no `AkumaStatusView` export, type alias, or wait
`statuses` compatibility field. Fleet never intersects the association into
`AkumaStatus`. Akuma core still knows no Contract, Dispatch, Task, or Repo,
and renderers perform no lookup. `CallObservation` and `AkumaHistoryResult`
remain on their current raw status/history shapes.

Wait and kill freeze their subject set at entry. A one-member wait defaults to
`all`; a multi-member wait requires `completion: "any" | "all"`. Any returns
after one member satisfies the ordinary Akuma wait predicate; all returns after
every member does. Timeout returns one complete aggregate of fresh observations
and is not a streaming or partial result. A plural aggregate carries one shared
30-row ordinary-detail budget, equal to five complete default `3 + 3` snapshots.
Each member uses the same `tail=3`, `voice=3` selector as ordinary status. After
that budget is spent, later members retain life, outcome, every running tool and
pending tell while ordinary detail collapses into typed gaps. When only part of
one member fits, its newest ordinary detail consumes the remainder. Kill returns one
evidence and compact post-action observation per selected AkuId in stable order.
`Keiyaku.tell` composes the handle's
typed mutation result with one subsequent whole-Akuma status observation. The
two fields have separate authority: `tell` alone states what this invocation
caused; `observation` gives the flagship current life, activity, outcomes, and
the two-state tell projection. Facade code never derives delivery or receipt
facts from that observation. Direct verbs accept only AkuId or Alias.
Their result carries the resolved AkuId, so an adapter never resolves a movable
Alias twice. History carries the same optional association beside its
history-specific value rather than inside it. `history({ last: true })` is the distinct last-answer arm: it reads
only the last answered turn by durable sequence and never reads status or
activity history. Its typed result is either `{ kind: "last", answer }`
(including an empty answer) or `{ kind: "no-answer" }`.

`Keiyaku.interrupt` remains a Library composition over one addressed Akuma:
pause the current Body, wait a bounded window for that Body to abort through
its owned live handles, obtain its leash, require an explicit end for the same
Body, atomically clear pause plus record the Tell, then wake a successor. A
held leash without the Body's durable failed-custody diagnostic reports
`unavailable`; the diagnostic reports `hung`; a free leash without clean
settlement reports `untidy`. It never signals from stored process coordinates.
This remains a composition rather than an Akuma storage primitive, and the CLI
exposes it only as `tell --interrupt`.

The Catalog facet owns one selected identity directory:

```ts
Keiyaku.ls(input: CatalogInput): Promise<Catalog>
```

`CatalogInput` is a closed union whose `query` is `tasks`, `contracts`,
`archetypes`, or `akuma`. Task and Akuma queries carry one resolved WorldRoot;
Contract queries carry one resolved Repo; Archetype queries carry optional
`home`. An Akuma query may select one Archetype or all instances. `Catalog`
is the corresponding closed result arm and contains only the selected rows.
There is no aggregate, absent section, failed-section wrapper, exact identity
selector, Alias selector, or cross-product fallback.

Each query invokes only its selected owner. Task queries read the Task board,
Contract queries read the Contract board, Archetype queries decode definition
catalog metadata, and Akuma queries delegate to `Akuma.list({ archetype? })`.
The Task Catalog consumes one complete Task-owned catalog snapshot rather than a
bounded Task list page, so it never silently omits identities or invents a second
Task query evaluator.
Akuma validates and applies the optional selection while decoding physical
identities; Catalog does not read or filter fleet rows. A selected-owner failure fails
the query; an unselected owner is never read and therefore cannot suppress it.
Catalog performs no path or Git discovery, Kanshi join, provider admission, or
activity/history read.

Named `status` selection remains an Address-facet operation. CLI composition
passes one Kanshi observation's report and retained Alias register with the
selector to the Address owner. That owner is the sole judge: it resolves a
complete Contract, complete AkuId, or `@name`, and explicitly refuses a name
shared by an active Contract short reference and an Akuma Alias. Catalog has
no role in this decision, and package-root callers do not receive a second
selector API.
