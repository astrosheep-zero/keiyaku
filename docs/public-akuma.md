# Public Akuma Facets

This chapter owns package-root Akuma creation, addressing, fleet, and cross-product composition.

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

The Address facet is the sole package-root selector expansion owner.
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

The Fleet facet composes only public Akuma handles after that expansion:

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

The Catalog facet owns the shallow package-root catalog:

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
selector is adjudicated by the Address facet and filters the corresponding
catalog. When `@name` names both an active
Contract short reference and an Akuma Alias, selection fails explicitly as
ambiguous. `ls` performs no Kanshi joins and no activity/history reads.
