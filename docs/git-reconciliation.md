# Git Reconciliation

This chapter owns replayable Contract topology effects, worktree hooks, effects, and lag.

## Reconciliation

Reconciliation computes desired-minus-actual effects from accepted facts and
fresh external observation. It is idempotent without process-local receipt data
and across a process restart. It writes no journal fact, never reverses
admission, and is the only repair primitive for accepted-but-lagged effects.

Each Contract reconciliation is one serialized Git effect decision. Git takes
one per-Contract coordination lock in the common Git directory, then observes
that Contract's current journal and worktree topology while holding the lock,
applies every ref, worktree, marker, and hook effect, and releases the lock.
Callers supply the Contract identity, never a previously folded state. The lock
contains no domain fact and is never removed with a managed worktree. Different
Contracts do not share this lock. Lock acquisition waits for the current effect
decision to finish rather than imposing a timeout shorter than a configured
hook command; process death releases the SQLite transaction. A Hook command has
one additional marker-local execution lock held by its detached Git runner for
the command's complete process lifetime. The runner, not the calling reconcile
process, reads the frozen command and durably records its resulting progress
before releasing that lock. Thus caller death may release the Contract lock but
cannot let a later reconcile overlap the still-running Hook command.

Ordinary admission does not take the per-Contract effect lock. Targeted
placement takes the separate canonical target fence described above. A public
mutation that admits a newer fact performs its mandatory reconciliation through
the per-Contract serialized entry, where it observes that newer state. Thus a
reconcile that began from an active state may finish its effects after a
terminal fact is admitted, but the terminal mutation's queued reconcile
observes terminal state and is the later effect decision.

Failure to observe or apply the requested topology is an explicit reconcile
result, not an untyped Git exception. The failed result retains every effect
that completed before the failure and identifies whether observation or effect
application failed. It makes no claim that an unreported effect did or did not
happen. Authority corruption and internal invariant failure remain exceptions.

For an active worktree contract, reconciliation creates the deterministic
linked worktree only when it is missing, and repairs only its Keiyaku-owned
refs and pins. It never resets, switches, or detaches an existing worktree.
For a here contract, reconciliation never creates, removes, switches,
detaches, or resets the caller-supplied worktree or its branch.

Target-checkout reconciliation exists only to finish the current claimed
placement's interrupted follow. It takes the same canonical target fence as
placement, rereads the claimed delivery and target ref, and applies only the
shape-proven recovery described above. It never adopts an ancestor as a base,
projects an older claim after a newer target movement, or retries an ordinary
pre-publication refusal. A completed checkout produces no effect; a completed
recovery reports `recovered`; an incompatible shape reports
`target-checkout-retained` and leaves every byte untouched. A checkout already
at the candidate needs no recovery effect.

A pending tender keeps its tender and integration reachable through
Keiyaku-owned refs in either workspace mode. Cleanup never moves the target ref.

Terminal removal of a managed worktree resolves the immutable tree and parent
metadata for its sealed commit identities once through the current Git decode
channel. It then begins by capturing its complete non-ignored workspace tree
through the same private-index mechanism as delivery. The tree is sealed when
it equals one of the journal-sealed trees and `HEAD` independently names one of
the journal-sealed commit identities. With no delivery, only start is sealed.
With a delivery, tender and integration trees are sealed, while start, tender,
integration, and the sealed tender commit's first parent are permitted `HEAD`
identities. That tender-parent case permits the ordinary base-`HEAD` plus dirty
tender-bytes shape only when the complete captured tree equals a sealed tree.
Dirty submodule internals are never sealed.

The resolved commit metadata is reused by both the judgment before destroy
hooks, the judgment after them, and same-tree custody comparison; both captures
still observe the complete workspace independently. An unsealed claimed
worktree or any worktree with dirty submodule internals is retained with every
required reachability ref and reports `unsealed-bytes` with the least differing
path set and, when applicable, the unsealed `HEAD`.

An unsealed abandoned worktree instead writes one ref-free recovery commit over
the first captured tree, runs the frozen destroy hooks, and captures again. If
the hook changes the tree or `HEAD`, a second recovery commit records that final
capture with the first recovery as parent. Hook failure still retains the
worktree and reports its lag; the already-created recovery remains an ephemeral
effect. A successful final capture with no dirty submodule internals permits
`git worktree remove --force`. The recovery tip appears only in that invocation's
effects, creates no ref or journal fact, and may be pruned by Git. Removal
precedes ref cleanup. That result must prove the appointed path is physically
absent before Place release; leftover bytes at an unregistered appointed path
are retention, not completed cleanup. Each Keiyaku-owned ref deletion
atomically verifies its surviving custodian ref. Integration custody requires
the exact integration commit; tender custody requires the exact tender tree and
may therefore pass to the claimed integration when their trees match.
Nonredundant custody remains. Retention never reverses or changes an accepted
outcome.

### Managed Worktree Hooks

Managed-worktree hooks are part of the typed worktree effect, not Contract
lifecycle facts or cross-product settlement. Git receives only this opaque
pure value from the library; it never reads Settings or interprets command
meaning:

```ts
type HookCommand = Readonly<{ argv: readonly string[]; timeoutMs: number }>
type WorktreeHooks = Readonly<{
  create: readonly HookCommand[]
  destroy: readonly HookCommand[]
}>
```

Each command runs directly, without a shell, in the managed worktree and
inherits the invocation environment. The shared process runtime bounds
stdout/stderr tails, enforces `timeoutMs`, and terminates the command process
tree on timeout. Commands must be serially replay-safe. The guarantee is
at-least-once: runner death after a command produces its effect and before its
progress is durably recorded can make a later runner execute that command
again. Concurrent replay is not required.

Immediately after creating a worktree, Git atomically writes
`keiyaku/hooks.json` beneath that linked worktree's Git administration
directory. The marker is outside candidate content and disappears only when
Git removes that managed worktree. The current hard-cut marker has version
`1`, freezes the complete create/destroy command pair, and records each phase
as `pending` with its next command index, `failed` with its command index and
typed process failure, or `ok`. Every marker replacement uses a unique
same-directory temporary file, fsyncs the file, renames it, and fsyncs the
parent directory when the host platform supports directory fsync. Windows does
not support fsync on an opened directory; on that platform the file fsync and
atomic same-directory rename remain the commit boundary and the unsupported
directory flush is omitted. Empty command arrays advance directly to `ok`.

Marker reads and parent-directory preparation are awaited. The shared
durable-file owner may retain synchronous descriptor write, file fsync, rename,
and platform-appropriate directory fsync only inside that atomic replacement
commit section; its Promise fulfills after the supported durability steps.
Reconciliation does not expose a synchronous marker API or defer marker
publication to a queue.

An active worktree with no marker freezes the current supplied pair and runs
create commands. A `pending` create phase resumes from its stored next index.
An `ok` create phase never runs again. A `failed` phase reports its stored lag
without running during ordinary reconciliation. Explicit
`reconcile({ retryHooks: true })` resumes that failed phase from its stored
command, still using the frozen pair; retry never recaptures current settings.
For each pending index, the detached runner takes the execution lock, rereads
the marker, and runs only when that exact index is still pending. A runner that
queued behind an earlier caller therefore observes the earlier progress and
does not repeat it. No running marker, pid lease, heartbeat, or age-based
recovery state exists.

The create order is worktree add, marker freeze, then create commands. A create
failure retains the worktree and does not reverse or abandon the accepted
Contract. The destroy order is initial capture and sealed-byte judgment,
optional abandonment recovery, frozen destroy commands, repeated capture and
optional recovery chaining, worktree removal, and atomic ref cleanup.
A destroy failure retains the worktree and all reachability refs. Settings
changes affect only a future worktree whose marker has not yet been frozen. Git
does not expose a generic hook registry, lifecycle event bus, backend interface,
or hook fact. Hook commands must not recursively invoke a mutation or
reconciliation for the same Contract: the outer effect decision owns that
Contract's lock until the command returns.

Git owns Verification scratch physical lifecycle. Verification
scratch is not a managed worktree effect and has none of this
marker, retry, or resume state. Its disposable path is asynchronously
materialized and disposed by Verification in one awaited invocation. The shared ordered command
primitive executes managed commands under this marker policy and scratch
commands without it; there is no mode switch or second recovery loop.
Reconciliation never resumes scratch provisioning or runs its repository
commands. From fresh registered-worktree topology, it removes only scratch
paths in Keiyaku's exact random namespace after nonblocking acquisition of that
path's exact `.<name>.owner.sqlite` exclusive transaction lock. Verification
holds the same lock from before worktree creation until disposal completes; OS
death releases it. Failure to acquire retains the worktree. No scratch name or
fact contains a pid, start token, or process identity. This is physical garbage
collection, not command recovery, and reads no transient Verification result.

```ts
type ReconcileResult = Readonly<{
  effects: readonly Effect[]
  lag: readonly ReconcileLag[]
}>

type ReconcileLag =
  | Readonly<{ kind: "worktree-retained"; path: string }>
  | Readonly<{
      kind: "unsealed-bytes"
      path: string
      paths: readonly string[]
      head?: SnapshotId
    }>
  | Readonly<{
      kind: "target-checkout-retained"
      path: string
      target: string
      diagnostic: string
    }>
  | Readonly<{
      kind: "worktree-hook-failed"
      phase: "create" | "destroy"
      path: string
      command: number
      failure: HookFailure
    }>
  | Readonly<{
      kind: "reconcile-failed"
      stage: "observation" | "effect"
      diagnostic: string
    }>

type HookFailure =
  | Readonly<{
      kind: "exit"
      code: number
      stdout: string
      stderr: string
      truncated: boolean
    }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "spawn-error"; diagnostic: string }>
  | Readonly<{ kind: "unknown-exit" }>

type Effect =
  | Readonly<{
      kind: "worktree"
      path: string
      action: "created" | "removed" | "unchanged"
    }>
  | Readonly<{
      kind: "target-checkout"
      path: string
      target: string
      action: "followed" | "recovered"
    }>
  | Readonly<{
      kind: "ref"
      name: string
      before: GitObjectId | null
      after: GitObjectId | null
      action: "created" | "updated" | "removed" | "unchanged"
    }>
```

`keiyaku.reconcile()` returns the contract's `ReconcileResult` as its public
`ReconcileReport`. World reconciliation returns:

```ts
type RepoReconcileItem = Readonly<{
  contractId: ContractId
  report: ReconcileReport
}>

type RepoReconcileReport = Readonly<{
  contracts: readonly RepoReconcileItem[]
}>
```

It contains one typed report for every observed contract. A failure lag does
not discard successful effects or reports and never becomes an aggregate
exception. Contract and world reconciliation use the same lag vocabulary.
Git owns no Task namespace bytes or ContractId-to-namespace policy; that
post-physical projection belongs to [settlement](settlement.md).

Effects and lag are transparent data. `changed` is derivable from effect
actions, resource coordinates are already in each effect, and lifecycle state
remains a journal projection. Commands and public reports expose only effects
actually observed in that operation and the flat `lag` array above; lag is not
nested in an effect or a second cleanup report. A report with lag is safe to
retry because every later reconcile starts from durable facts and fresh
topology rather than an in-memory receipt.
