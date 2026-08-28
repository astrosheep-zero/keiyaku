# Settlement

Settlement is the sole owner of Contract-to-Task coordination. It owns the
TaskHolder fact, judges whether a Contract is the current holder, and projects
accepted Contract state into Task state. Contract journals and Task Markdown
remain their products' lifecycle authorities; the holder is only the one
cross-product association authority.

Fork bind has no Task input and creates no TaskHolder, settlement relation,
lineage, sibling registry, or comparison outcome. It reaches Settlement only
as an ordinary new Contract after admission.

No other module may import both Contract write-side facts and Task write
operations. Core Contract decisions, Git admission, Task, and Akuma do not
import settlement. The package-root Library composes holder changes into
Contract admission and invokes settlement after Git reconciliation. CLI never
invokes it directly. Kanshi may consume its read projection but never settles.

## TaskHolder Authority

There is one canonical holder record per complete `TaskId` in the private Git
tree:

```text
settlement/task-holders/<sha256(TaskId)>.json
```

```ts
type TaskHolder = Readonly<{
  version: 1
  taskId: TaskId
  contractId: ContractId
  disposition: "held" | "released"
}>
```

The fixed SHA-256 locator bounds Git tree depth; the canonical bytes retain the
complete TaskId and the reader verifies that it hashes to the path. The record
is never deleted. A new `bind({ task })` replaces that Task's record with
`held` for the new Contract. An abandon replaces it with `released` only when
the abandoning Contract is still the current `held` holder. An older Contract
therefore cannot release or settle a Task after a newer bind supersedes it.

Settlement is the sole holder path, codec, read, and currentness judge.
Library asks it to attach claim or release bytes to an Offer; Git sees only the
generic companion path and bytes. The holder mutation and the bind or abandon
journal entries publish in one private-root CAS. A post-admission release
published by Settlement uses the same private-root CAS against one frozen
observation. There is no reverse index, Task-side copy, delete operation,
compatibility decoder, or independent holder writer.

Holder claim and release serialize on one per-Task fence: a SQLite transaction
lock per `TaskId` at
`<commonGitDir>/keiyaku/locks/settlement/<sha256(TaskId)>.sqlite`, acquired in
`immediate` mode and held for the
duration of an admission action. Bind's holder claim and abandon's holder
release run inside it. The fence serializes holder claim and release only. The
post-admission Task `done` write does not pass through the fence: the Task
store's predecessor-CAS adjudicates it against
the on-disk document, and a concurrent Task write is reported as a Task lag
reconsidered on replay.

## Rules

Settlement has exactly these rules:

1. A `claimed` Contract whose current holder is `held` moves that one Task from
   `open`, `in_progress`, or `on_hold` to `done`, then writes the holder as
   `released`. An already `done` Task is unchanged and the holder is still
   released. A `drop` Task refuses the settlement transition and produces a
   lag; the holder stays `held` for a later replay.
2. A terminal Contract with no current matching `held` holder does nothing:
   Settlement does not enter, establish, read, or repair World, Task, or
   namespace-context state. This is how missing, released, and superseded
   holders remain inert under settlement replay.
3. After proving a matching `held` holder from the frozen observation,
   Settlement installs or repairs the Task context for each managed Contract
   worktree reported as present by Git through the Task-owned primitive at that
   worktree root. Settlement does not construct a World at that path. The
   default context value is the ContractId's human contract segment as a
   TaskId namespace. A valid local override is kept.

Settlement owns the canonical Contract-derived TaskId namespace
`[contractSegment(contractId)]`. That coordinate is a source/value of context
or a TaskId namespace, never a third namespace kind. Worktree repair installs
it as directory context; Kanshi consumes the same one-segment TaskId namespace
for exact matching and never consults directory context. A Task matches only
when its complete TaskId namespace equals it; root, sibling, nested,
world-current, and managed override context values do not change the
observation. A match creates no holder, endpoint, lifecycle effect, or
association; TaskHolder remains their sole authority.

Settlement observes TaskHolder authority only when a candidate is `claimed`,
because only a `claimed` candidate can reach the Task rule. A call without a
matching held holder is strictly zero effect; namespace settlement is a
holder-bearing effect, never a consequence of supplied Contract state and Git
effects alone.

It has no Akuma rule. New rules require an owner-law change here; there is no
event bus, registry, provider interface, or generic lifecycle-hook vocabulary.

## Reports

```ts
type SettlementAction =
  | Readonly<{
      kind: "task"
      taskId: TaskId
      action: "done"
    }>
  | Readonly<{
      kind: "namespace-context"
      path: string
      action: "installed" | "kept"
    }>

type SettlementLag = Readonly<{
  kind: "settlement-failed"
  surface: "task-holder" | "task" | "namespace-context"
  contractId: ContractId
  taskId?: TaskId
  path?: string
  diagnostic: string
}>

type SettlementReport = Readonly<{
  actions: readonly SettlementAction[]
  lags: readonly SettlementLag[]
}>
```

Actions contain only completed or directly observed work. Holder observation
failure or a failed or non-published release produces one `task-holder` lag. A
missing target Task, Task refusal, retry, or failed write produces a Task lag
naming that Task. Namespace failure produces a lag naming the worktree path.
Settlement continues independent rules after a lag.

## Execution And Replay

The package-root flow is:

```text
protocol admission -> Git reconcile -> settlement -> public result
```

Admission is the irreversible point. Git or settlement failure never changes
an accepted fact, creates `abandoned`, or rejects the public mutation. The
result returns admitted facts and head, observed Git effects and lags, and the
complete `SettlementReport`. Settlement is synchronous in that public Promise;
a lag reports incomplete follow-up without hiding the admitted Contract.
Settlement reads Git authority from the pinned primary worktree, never the
invocation worktree, because a terminal reconcile may have removed that
worktree. The package-root Library defers terminal managed-worktree removal
until after settlement, so one invocation settles first and removes last; a
later replay still settles correctly because the primary worktree remains.

Settlement derives desired work from current Contract state, current
TaskHolder authority, current Task Markdown, and the current Git report on
every invocation. It records no completion bit. Re-running Contract or world
reconciliation repeats Git reconciliation and the same settlement rules. Task
predecessor-byte comparison remains the Task write adjudicator; concurrent
movement becomes a lag and is reconsidered later. Settlement uses the current
holder only to select its per-Task settlement fence. Once it holds that fence,
it rereads the matching holder before deciding work, retains the fence through
the Task-owned `done` operation, then acquires Git's private-state seat inside
that fence. It freezes a fresh Contract and holder observation there for the
release write's expected OID assertion. The seat stays held through release
publication and exact unknown-outcome read-back; Task predecessor-byte
comparison remains the only Task-write adjudicator. A non-published release is
reported as a `task-holder` lag and is retried on a later replay.

## Hook Boundary

Task settlement is not a hook. A hook is an external command attached to a
typed physical effect and is owned by that effect's product. The only current
hooks are Git-owned managed-worktree create and destroy commands. Future
non-worktree behavior requires a concrete settlement rule here; settlement
does not expose Contract, Task, or Akuma lifecycle events as configurable
hooks.
