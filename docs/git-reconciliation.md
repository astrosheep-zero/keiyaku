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
applies every ref, worktree, and hook effect, and releases the lock.
Callers supply the Contract identity, never a previously folded state. The lock
contains no domain fact and is never removed with a managed worktree. Different
Contracts do not share this lock. Lock acquisition waits for the current effect
decision to finish rather than imposing a timeout shorter than a configured
hook command; process death releases the SQLite transaction. Hook commands run
serially in the current caller and leave no marker, frozen snapshot, detached
runner, or marker-local lock. Hook authors own idempotence; whole-phase retry
reruns the complete current command list.

Confirmed Git reset is not reconciliation. It does not compute
desired-minus-actual effects, replay hooks as lifecycle recovery, or reverse
admission. Managed-worktree hooks leave no marker residue; SQLite lock files remain. A failed reset attempt stays
retryable and may keep independently completed effects.

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

Before applying one observed Contract's topology, reconciliation converges
each legacy delivery or candidate leaf into its corresponding canonical
`refs/keiyaku/` leaf. Reconciliation observes both custody pairs before any
write. If neither pair conflicts, one `update-ref` transaction moves every
legacy-only leaf by creating its canonical leaf and deleting the expected
legacy OID. When both leaves name the same OID, that transaction verifies the
canonical leaf and deletes only the legacy leaf. Runtime never dual-writes
these namespaces.

When corresponding legacy and canonical leaves name different OIDs,
reconciliation changes neither leaf and returns `ref-migration-conflict` with
both ref names and OIDs. It performs no later topology effect for that Contract
until the conflict is externally resolved, so neither object loses its
custodian. A Contract-absent legacy leaf is an orphan and is not adopted or
deleted by reconciliation. Confirmed reset remains the only owner operation
that enumerates both roots. No marker, second inventory, bulk migration, or
standalone migrate command exists.

For an active worktree contract, reconciliation repairs its custody ref, then
projects an existing managed worktree, runs create-hook recovery, and repairs
its candidate pin. It creates the deterministic linked worktree only when it
is missing, directly detached at its tender or start snapshot. With no
delivery, an existing worktree is unchanged. With a delivery, an existing
worktree whose detached `HEAD` already equals `tenderSnapshot` is unchanged:
reconciliation does not rewrite its index or files.

Otherwise, a dirty tender follows only when the existing worktree has a
detached `HEAD` equal to the tender's first parent. A one-parent tender admits
no merge, rebase, cherry-pick, revert, or unmerged-index state. A two-parent
tender admits only its captured resolved merge: `MERGE_HEAD` names the tender's
second parent, the index has no unmerged entries, and no other operation is in
progress. No other parent shape follows. The admitted transition is Git's
native mixed reset to `tenderSnapshot`, which moves only detached `HEAD` and
the real index, does not write worktree files, and clears the resolved merge
state through that native transition.

Every other existing delivery shape leaves `HEAD`, index, operation metadata,
and files unchanged and reports retryable `worktree-follow-retained`. Its
reason is `head-attached` for an attached `HEAD`, `head-moved` for a detached
`HEAD` other than the tender or its first parent, `operation-in-progress` for
an inadmissible operation or unmerged index, and `unsupported-parent-shape`
for a tender other than one or two parents. Observation or Git execution
failure remains `reconcile-failed`; it is not a retained follow shape. A
follow reports `worktree` action `followed` with its before and after snapshot.
No target ref moves, attached branch follows, extra commits, refs, markers, or
persisted follow state exist.

Dependency continuation has one additional, invocation-local managed-worktree
follow. It targets the predecessor's claimed integration snapshot and is
allowed only when the dependent's detached `HEAD` is an ancestor of that
snapshot. A dry-run observes tracked staged/unstaged paths, untracked paths,
submodule paths, `MERGE_HEAD`, operation metadata, and unmerged entries before
any write. Any
dirty, attached, non-ancestor, merge, or conflict shape is retained with a
`worktree-follow-retained` lag naming the exact path, head, target (`tender`),
reason, and dirty paths when present. A clean ancestor uses Git's native
detached-checkout carry-forward, advancing the managed detached `HEAD` while
updating its index and materializing the target worktree files, and reports the
existing `worktree followed` effect. This physical repair appends no journal fact, moves no target ref, and
never recaptures a candidate or reruns review; it is finite and idempotent
under the dependent's existing reconcile lock.
Target-checkout reconciliation exists only to finish the current claimed
placement's interrupted follow. It takes the same canonical target fence as
placement, rereads the claimed delivery and target ref, and applies only
shape-proven recovery of that claimed predecessor-to-candidate movement. It
never adopts an ancestor as a base, projects an older claim after a newer
target movement, or retries an ordinary pre-publication refusal.

Recovery may replay only the current claimed predecessor-to-candidate movement
when the relevant checkout state can carry it. That replay may change only the
semantic entries affected by the claimed movement. Unrelated semantic index
and worktree state, including staging admitted concurrently after recovery
observation, is preserved. Relevant concurrent or incompatible state that
cannot carry the movement is retained without overwrite and reports existing
target-checkout lag. A recovery reports `recovered` only after Git completes
its native carry-forward.

A completed checkout produces no effect; a completed recovery reports
`recovered`; an incompatible shape reports `target-checkout-retained` and
leaves every byte untouched. A checkout already at the candidate needs no
recovery effect. Selected Contract status may independently judge that same
pure shape as `CurrentPhysicalIssue`.
That projection performs no reconcile, acquires no lock, mutates no refs or
worktrees, and executes no hooks. World status and the Contract catalog omit
it.

A pending tender keeps its tender and integration reachable through
Keiyaku-owned refs for the managed worktree. Cleanup never moves the target ref.

Before terminal cleanup, a caller may retain the appointed managed worktree for
one post-admission Settlement pass. Git reports that still-present path as a
`worktree unchanged` effect; this is topology observation, not a second
appointment or worktree authority. Cleanup remains a later reconciliation
decision.

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
the first captured tree, runs the destroy hooks, and captures again. If
the hook changes the tree or `HEAD`, a second recovery commit records that final
capture with the first recovery as parent. Hook failure still retains the
worktree and reports its lag; the already-created recovery remains an ephemeral
reconciliation effect. A successful final capture with no dirty submodule internals permits
`git worktree remove --force`. An accepted mutation projects the final recovery
tip only as its `recoverySnapshot`, never by exposing the reconciliation effects
collection; it creates no ref or journal fact, and may
be pruned by Git. Removal
precedes ref cleanup. That result must prove the appointed path is physically
absent before Place release; leftover bytes at an unregistered appointed path
are retention, not completed cleanup. Each Keiyaku-owned ref deletion
atomically verifies its surviving custodian ref. Integration custody requires
the exact integration commit. A frozen target tip may serve as that custodian
only when Git ancestry proves the integration is reachable from the tip; the
deletion transaction verifies the target still names that frozen tip. A later
advance that keeps the integration reachable is therefore usable custody on
retry, while a rewrite or missing target is not. Tender custody requires the
exact tender tree and may therefore pass to the claimed integration when their
trees match. Nonredundant custody remains. Retention never reverses or changes
an accepted outcome. Retained owned refs are reported as `ref` effects with
`action: "unchanged"` that preserve the current OID, so retryable retention is
observable without claiming deletion.

### Managed Worktree Hooks

Managed-worktree hooks are part of the typed worktree effect, not Contract
lifecycle facts or cross-product settlement. Git receives only this opaque
pure value from the library; it never reads Settings or interprets command
meaning:

```ts
type HookCommand = Readonly<{ name: string; argv: readonly string[]; timeoutMs: number }>
type WorktreeHooks = Readonly<{
  create: readonly HookCommand[];
  destroy: readonly HookCommand[];
}>;
```

Each command runs directly, without a shell, in the managed worktree and
inherits the invocation environment. The shared process runtime bounds
stdout/stderr tails, enforces `timeoutMs`, and terminates the command process
tree on timeout. Commands must be serially replay-safe. Callers may replay a
complete phase after transient failure; hook authors own idempotence.

Immediately after creating a worktree, Git runs the supplied create commands in
order in the current caller. There is no marker, frozen command snapshot,
detached runner, marker-local lock, or persisted progress. An unchanged active
worktree skips create hooks; `retryHooks` reruns the complete current create
list. A failed hook reports transient lag with its name and command index, and
the next retry starts from the beginning. Destroy hooks run on each cleanup
attempt reaching the hook stage and retry reruns the complete destroy list.
The create order is worktree add, then create commands. A create
failure retains the worktree and does not reverse or abandon the accepted
Contract. The destroy order is initial capture and sealed-byte judgment,
optional abandonment recovery, destroy commands, repeated capture and
optional recovery chaining, worktree removal, and atomic ref cleanup.
A destroy failure retains the worktree and all reachability refs. Settings
changes affect the next invocation. Git
does not expose a generic hook registry, lifecycle event bus, backend interface,
or hook fact. Hook commands must not recursively invoke a mutation or
reconciliation for the same Contract: the outer effect decision owns that
Contract's lock until the command returns.

Git owns Verification scratch physical lifecycle. Verification
scratch is not a managed worktree effect and has no retry or durable marker
state. Its disposable path is asynchronously
materialized and disposed by Verification in one awaited invocation. The shared ordered command
primitive executes managed and scratch commands with the same ordered
semantics; there is no mode switch or second recovery loop.
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
  hookRuns?: readonly { phase: "create" | "destroy"; name: string }[]
}>

type ReconcileLag =
  | Readonly<{ kind: "worktree-retained"; path: string }>
  | Readonly<{
      kind: "unsealed-bytes";
      path: string;
      paths: readonly string[];
      head?: SnapshotId;
    }>
  | Readonly<{
      kind: "target-checkout-retained";
      path: string;
      target: string;
      diagnostic: string;
    }>
  | Readonly<{
      kind: "worktree-hook-failed"
      phase: "create" | "destroy"
      path: string
      command: number
      name: string
      failure: HookFailure
    }>
  | Readonly<{
      kind: "ref-migration-conflict";
      legacyRef: string;
      legacyOid: GitObjectId;
      currentRef: string;
      currentOid: GitObjectId;
    }>
  | Readonly<{
      kind: "reconcile-failed";
      stage: "observation" | "effect";
      diagnostic: string;
    }>;

type HookFailure =
  | Readonly<{
      kind: "exit";
      code: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
    }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "spawn-error"; diagnostic: string }>
  | Readonly<{ kind: "unknown-exit" }>;

type Effect =
  | Readonly<{
      kind: "worktree";
      path: string;
      action: "created" | "removed" | "unchanged";
    }>
  | Readonly<{
      kind: "target-checkout";
      path: string;
      target: string;
      action: "followed" | "recovered";
    }>
  | Readonly<{
      kind: "ref";
      name: string;
      before: GitObjectId | null;
      after: GitObjectId | null;
      action: "created" | "updated" | "removed" | "unchanged";
    }>;
```

`keiyaku.reconcile()` returns the contract's `ReconcileResult` as its public
`ReconcileReport`. World reconciliation first performs one frozen Git
observation to discover the complete Contract world. That observation is
atomic: it either yields the complete world, including zero Contracts, or
fails before any ContractId exists. The public report is exactly:

```ts
type RepoReconcileItem = Readonly<{
  contractId: ContractId;
  report: ReconcileReport;
}>;

type RepoReconcileReport =
  | Readonly<{
      kind: "completed";
      contracts: readonly RepoReconcileItem[];
    }>
  | Readonly<{
      kind: "world-observation-failed";
      diagnostic: string;
    }>;
```

`completed` with `contracts: []` means the frozen world was read successfully
and contains no Contracts. `world-observation-failed` is only an operational
IO/Git observation failure before discovery yields ContractIds. It never
contains a synthetic ContractId or a partial discovery list. Authority
corruption and type errors remain exceptions. Per-Contract `ReconcileReport`
shapes, including typed observation failures and successful effects after
discovery, do not change. No new aggregate failure arm is used once discovery
has completed.

A completed report contains one typed report for every observed contract. A
failure lag does not discard successful effects or reports and never becomes
an aggregate exception. Contract and world reconciliation use the same lag
vocabulary. Git owns no Task namespace bytes or ContractId-to-namespace
policy; that post-physical projection belongs to [settlement](settlement.md).

Effects and lag are transparent data. `changed` is derivable from effect
actions, resource coordinates are already in each effect, and lifecycle state
remains a journal projection. Commands and public reports expose only effects
actually observed in that operation and the flat `lag` array above; lag is not
nested in an effect or a second cleanup report. A report with lag is safe to
retry because every later reconcile starts from durable facts and fresh
topology rather than an in-memory receipt.
