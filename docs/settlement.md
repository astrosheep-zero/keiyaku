# Settlement

Settlement is the sole write-side coordinator across Contract and Task. It
projects an accepted Contract state into the expected state of other products;
it is not authority, stores no receipt or marker, and owns no lifecycle.
Contract journal facts and Task Markdown remain their products' sole
authorities.

No other module may import both Contract write-side facts and Task write
operations. Protocol, Git, Task, and Akuma do not import settlement. CLI
never invokes it directly. The package-root library invokes settlement after
Git reconciliation for every accepted mutation and for both contract and
world reconciliation. Kanshi remains read-only and never settles.

## Rules

Settlement has exactly these rules:

1. A `claimed` Contract moves every Task whose `contractId` equals that
   ContractId from `open`, `in_progress`, or `on_hold` to `done`. An already
   `done` Task is unchanged. A `drop` Task is not reopened or rewritten.
2. An `abandoned` Contract moves every associated `done` Task to `open`. This
   coordination-only transition is not a public Task verb. It applies equally
   when the Task was completed manually; clearing `contractId` opts the Task
   out before settlement.
3. An active managed Contract worktree reported as present by Git has
   its Task namespace context installed or repaired. The default namespace is
   the ContractId's human contract segment. A valid local override is kept.

Association matching is verbatim. Settlement does not impose uniqueness on
`contractId`; every matching Task is considered independently. It has no Akuma
rule. New rules require an owner-law change here; there is no event bus,
registry, provider interface, or generic lifecycle-hook vocabulary.

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
  surface: "task" | "namespace-context"
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

Actions contain only completed or directly observed work. An unavailable Task
board produces one Task lag; an individual Task refusal, retry, or failed write
produces a lag naming that Task. Namespace failure produces a lag naming the
worktree path. Settlement continues independent rules after a lag.

## Execution And Replay

The package-root flow is:

```text
protocol admission -> Git reconcile -> settlement -> public result
```

Admission is the irreversible point. Git or settlement failure never
changes an accepted fact, creates `abandoned`, or rejects the public mutation.
The result returns the admitted facts and head, the Git effects and lags
actually observed, and the complete `SettlementReport`. Settlement is
synchronous in that public Promise; a lag reports incomplete follow-up without
blocking the Contract lifecycle fact.

Settlement derives desired work from the current Contract facts, current Task
Markdown, and the current Git report on every invocation. It records no
completed bit. Re-running `keiyaku.reconcile()` or world reconciliation repeats
Git reconciliation and the same settlement rules, making both the
normal recovery paths. Task predecessor-byte comparison remains the write
adjudicator; a concurrent movement becomes a lag and is reconsidered later.

## Hook Boundary

Task settlement is not a hook. A hook is an external command attached to a
typed physical effect and is owned by that effect's product. The only current
hooks are Git-owned managed-worktree create and destroy commands. Future
non-worktree behavior requires a concrete settlement rule here; settlement
does not expose Contract, Task, or Akuma lifecycle events as configurable
hooks.
