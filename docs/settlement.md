# Settlement

Settlement is the sole owner of Contract-to-Task coordination. It owns the
TaskHolder fact, judges whether a Contract is the current holder, and projects
accepted Contract state into Task state. Contract journals and Task Markdown
remain their products' lifecycle authorities; the holder is only the one
cross-product association authority.

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
journal entries publish in one private-root CAS. Release is retained rather
than represented by absence because post-abandon settlement and replay must
still know which Task to reopen. There is no reverse index, Task-side copy,
delete operation, compatibility decoder, or independent holder writer.

## Settlement Fence

Settlement owns one private coordination fence per complete `TaskId`. Its path
is derived beneath the repository common Git directory and uses the repository's
single SQLite transaction-lock primitive. The fence stores no product facts;
TaskHolder and Task Markdown remain the durable authorities. Process death
releases it with the SQLite connection. There is no flock, PID, lease,
heartbeat, stale-break record, or second lock implementation.

A bind claim holds that Task's fence across every holder-mutating admission
attempt. Abandon first locates its possible held Task, then holds that fence
while a fresh admission observation decides whether to publish the release.
The fenced observation is decisive; the locator never is. Fence acquisition or
release failure before admission admits no Contract or holder fact.

Settlement uses an initial holder projection only to locate the possible Task
fence. Inside the fence it reads current Contract state and the complete current
TaskHolder projection from one frozen state snapshot, judges currentness, then
calls Task's existing locked predecessor-CAS transition. The only lock order is
`settlement fence(Task) -> Task lock(Task)`. Reconcile releases its effect lock
before Settlement starts, and world settlement finishes one Task fence before
acquiring another.

A complete holder read consumes one `GitReadObservation` from the Git owner.
Settlement selects TaskHolder paths and object IDs from its immutable snapshot,
requests those blobs once, and exclusively performs path, codec,
canonical-byte, duplicate, sorting, and projection judgment. A missing holder
object or malformed holder fact fails the holder observation; Git does not
decode it. Settlement receives the public mutation's shared decode channel but
opens its own fresh settlement epoch. The initial locator observation and each
fenced settlement observation are likewise separate ref freezes on that same
channel; an earlier projection never authorizes the fenced Task write.

## Rules

Settlement has exactly these rules:

1. A `claimed` Contract whose current holder is `held` moves that one Task from
   `open`, `in_progress`, or `on_hold` to `done`. An already `done` Task is
   unchanged. A `drop` Task refuses the settlement transition and produces a
   lag.
2. An `abandoned` Contract whose current holder is `released` moves that one
   Task from `done` to `open`. Other Task states are unchanged. This
   coordination-only transition is not a public Task verb.
3. A terminal Contract with no current matching holder does nothing. This is
   how superseded holders remain inert under settlement replay.
4. An active managed Contract worktree reported as present by Git has its Task
   namespace context installed or repaired. The default namespace is the
   ContractId's human contract segment. A valid local override is kept.

It has no Akuma rule. New rules require an owner-law change here; there is no
event bus, registry, provider interface, or generic lifecycle-hook vocabulary.

## Reports

```ts
type SettlementAction =
  | Readonly<{
      kind: "task"
      taskId: TaskId
      action: "done" | "reopened"
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

Actions contain only completed or directly observed work. Holder corruption or
read failure produces one `task-holder` lag. A missing target Task, Task
refusal, retry, or failed write produces a Task lag naming that Task. Namespace
failure produces a lag naming the worktree path. Settlement continues
independent rules after a lag.

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
If a holder mutation admits but releasing its fence fails, the public result
preserves the admitted facts and reports a `task-holder` Settlement lag. It
does not begin reconcile or settlement while fence release remains uncertain.

Settlement derives desired work from current Contract state, current
TaskHolder authority, current Task Markdown, and the current Git report on every
invocation. It records no completion bit. Re-running Contract or world
reconciliation repeats Git reconciliation and the same settlement rules. Task
predecessor-byte comparison remains the Task write adjudicator; concurrent
movement becomes a lag and is reconsidered later.
World reconciliation reads and validates one immutable TaskHolder projection
as a locator, then settles Contracts sequentially. Each possible Task write is
decided again from one complete frozen projection inside that Task's fence; the
locator never authorizes a write and is not retained across invocations.

## Hook Boundary

Task settlement is not a hook. A hook is an external command attached to a
typed physical effect and is owned by that effect's product. The only current
hooks are Git-owned managed-worktree create and destroy commands. Future
non-worktree behavior requires a concrete settlement rule here; settlement
does not expose Contract, Task, or Akuma lifecycle events as configurable
hooks.
