# Settlement

Settlement owns Contract-to-Task association and managed-worktree namespace
projection. It does not translate an admitted Contract terminal into a later
Task lifecycle write. Contract journals and Task Markdown remain their sole
lifecycle authorities; TaskHolder is only the cross-product association and
currentness authority.

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

The complete identity remains in canonical bytes and is checked against the
fixed-depth locator. `bind({ task })` publishes `held` in the same private-root
CAS as bind. Abandon publishes `released` only while that Contract is still the
current holder. Settlement alone owns this path, codec, projection, and
currentness judgment. Git sees only opaque companion path/byte updates.

A Task with a current `held` record is exclusive: a second `bind({ task })` is
refused by the same holder observation and fence. A new Contract may bind the
Task only after the current holder has released it through `abandon`. Holder
replacement never silently erases an active Contract's completion obligation.

The per-Task SQLite fence serializes holder replacement and release. It stores
no product fact, lease, PID, heartbeat, or completion bit. Fence failure before
admission admits nothing; uncertain release after admission is reported as a
`task-holder` settlement lag.

## Delivery Boundary

For a current held Task, Settlement supplies the Task identity from the frozen
delivery or review admission observation. Task owns the canonical pure
`open | in_progress | on_hold -> done` document transition. Git overlays those
opaque bytes into the integration tree and computes the final ChangeId and
snapshot. Settlement never reads or writes Task Markdown in this flow.

Placement rechecks the holder inside the same fresh private-state observation
used to offer `claimed`. A moved or released holder refuses placement. The
existing atomic private-state/target-ref publication therefore makes the
reviewed integration containing `done` and `claimed` enter the world together.
Abandon only releases the association; it never reopens Task authority.

## Namespace Rule

An active managed Contract worktree reported as present by Git has its Task
namespace context installed or repaired. The default namespace is the human
Contract segment. A valid local override is kept. This is the only
post-admission projection Settlement performs.

```ts
type SettlementAction = Readonly<{
  kind: "namespace-context"
  path: string
  action: "installed" | "kept"
}>

type SettlementLag = Readonly<{
  kind: "settlement-failed"
  surface: "task-holder" | "namespace-context"
  contractId: ContractId
  taskId?: TaskId
  path?: string
  diagnostic: string
}>
```

Reconciliation may replay namespace repair. There is no claimed-to-done rule,
abandoned-to-open rule, Task lifecycle lag, Task write retry, or completion
ledger to replay. Task completion is already tracked delivery content.

## Hook Boundary

Settlement is not an event bus or configurable lifecycle hook. The only
current external hooks are Git-owned managed-worktree create and destroy
commands. New cross-product rules require concrete owner law here.
