# Public Mutation Results

## Nuke Result Shape

```ts
type NukeResult =
  | Readonly<{
      kind: "success"
      world: WorldRoot
    }>
  | Readonly<{
      kind: "failed"
      world: WorldRoot
      diagnostic: string
    }>

type NukeConfirmationRequiredRefusal = Readonly<{
  kind: "nuke-confirmation-required"
  world: string
}>

type NukeConfirmationRefusal = Readonly<{
  kind: "nuke-confirmation-mismatch"
  world: string
  confirmation: string
}>

```

This chapter owns the package-root nuke result and refusal shapes. Reset
semantics and preservation law live in [world.md](world.md).

Kanshi Contract rows expose `lastJournalAt`, the timestamp of the final entry
in the frozen journal observation used to fold that row. Akuma fleet rows
expose `lastActivityAt`, the timestamp of the highest-sequence retained Heart
timeline row, or `null` when no timeline activity exists. These are source
timestamps, not durations or lifecycle substitutes.

## Mutation Results And Errors

Protocol owns its internal three-arm outcome and uses it only to compose an
invocation. The package root does not export that control-flow structure.
Library is the sole public facade: it projects accepted protocol outcomes into
success values, throws typed pre-admission domain failures, and performs the
mandatory post-admission Git reconciliation and settlement before
returning. Post-admission failure is reported as lag without hiding or
rejecting the admitted Contract. CLI calls this same facade; it does not
interpret protocol outcomes or repeat either follow-up stage.

`MutationResult` is invocation-scoped observation, never Contract state or a
durable receipt. `facts` and `head` come only from accepted protocol admission.
When claim continuation admits facts for dependent Contracts, `facts` contains
those consequence facts while `head` remains the addressed Contract's head.
`effects` and `lags` first contain physical results produced inside targeted
placement fences, then one mandatory Git reconciliation for every Contract
whose facts were admitted; `settlement` combines those reconciliation-owned
settlements. There is no nested `receipt`,
duplicate fact field, or result stored on a `Keiyaku` handle.

```ts
type KeiyakuRetryReason =
  | Readonly<{ kind: "exhausted" }>
  | Readonly<{ kind: "collision" }>
  | Readonly<{
      kind: "publication-failed"
      diagnostic: string
    }>

type MutationResult<A> = Readonly<{
  facts: readonly Fact[]
  head: ContractHead
  value: A
  effects: readonly TopologyEffect[]
  lags: readonly Lag[]
  settlement: SettlementReport
  cleanup?: VerificationCleanupFailure
  leak?: WorktreeLeak
}>

type RecoverySnapshotEffect = Readonly<{
  kind: "recovery-snapshot"
  action: "created"
  snapshot: SnapshotId
  retention: "ephemeral"
}>

class KeiyakuRefused extends Error {
  readonly refusal: KeiyakuRefusal
  readonly code: KeiyakuRefusal["kind"] // derived getter over refusal.kind
}

class KeiyakuRetry extends Error {
  readonly reason: KeiyakuRetryReason
  readonly code: KeiyakuRetryReason["kind"] // derived getter over reason.kind
}

type WorktreeLeak = Readonly<{
  path: string
  diagnostic: string
}>

export type RegionOverlap = Readonly<{
  contract: ContractId
  patterns: readonly Readonly<{ mine: string; theirs: string }>[]
}>

type RegionObservation = Readonly<
  | { overlaps: readonly RegionOverlap[]; overlapFailure?: never }
  | { overlapFailure: string; overlaps?: never }
>

type BindResult = Readonly<
  Omit<MutationResult<Keiyaku>, "value"> &
  { keiyaku: Keiyaku } &
  RegionObservation
>

type AmendResult = Readonly<
  MutationResult<void> &
  RegionObservation &
  { documentDiff: string }
>

type StepStop<R> = Readonly<
  | { refusal: R; retry?: never }
  | { retry: KeiyakuRetryReason; refusal?: never }
>

type AttestationRefusal = Readonly<{
  kind: "contract-missing" | "terminal"
  contractId: ContractId
}>

type AmendRefusal = Readonly<{
  kind:
    | "contract-missing"
    | "terminal"
    | "terms-moved"
    | "unknown-prerequisite"
    | "cyclic-prerequisite"
  contractId: ContractId
}>

type UnmetPrerequisite = Readonly<{
  contractId: ContractId
  state: "missing" | "active" | "abandoned"
}>

type PlacementRefusal = Readonly<{
  kind:
    | "contract-missing"
    | "delivery-missing"
    | "terminal"
    | "gates-unsatisfied"
  contractId: ContractId
}> | Readonly<{
  kind: "prerequisites-unsatisfied"
  contractId: ContractId
  unmet: readonly UnmetPrerequisite[]
}>

type IntegrationRefusal = Readonly<{
  kind: "integration-failed"
  contractId: ContractId
  reason: "not-based-on-target" | "unrelated-histories"
  targetHead: SnapshotId
}> | Readonly<{
  kind: "integration-failed"
  contractId: ContractId
  reason: "conflict"
  targetHead: SnapshotId
  conflictPaths: readonly string[]
  recovery: Readonly<{
    materialize: "deliver --materialize-conflict"
    continue: "deliver"
  }>
}> | Readonly<{
  kind: "integration-unsupported"
  contractId: ContractId
  requiredGit: "2.38"
}>

type MergeStatePresentRefusal = Readonly<{
  kind: "merge-state-present"
  contractId: ContractId
  workspace: Readonly<{
    kind: "here" | "worktree"
    path: string
  }>
}>

type IntegrationConflictMaterialized = Readonly<{
  kind: "integration-conflict-materialized"
  targetHead: SnapshotId
  conflictPaths: readonly string[]
  workspace: Readonly<{
    kind: "here" | "worktree"
    path: string
  }>
}>

type CheckoutNotFollowableRefusal = Readonly<{
  kind: "checkout-not-followable"
  contractId: ContractId
  target: string
  path: string
  reason: "staged" | "conflict" | "untracked"
  paths: readonly string[]
}>

type DeliveryWorkspaceRefusal = Readonly<{
  kind: "workspace-not-on-target"
  contractId: ContractId
  target: string
  branch: string | null
}>

type DeliveryPreparationRefusal =
  | Readonly<{ kind: "target-missing" | "worktree-missing"; contractId: ContractId }>
  | DirtyWorkspaceRefusal
  | UnmergedPathsRefusal
  | IntegrationRefusal
  | MergeStatePresentRefusal
  | CheckoutNotFollowableRefusal
  | DeliveryWorkspaceRefusal

type DirtyWorkspaceRefusal = Readonly<{
  kind: "dirty-workspace"
  contractId: ContractId
  staged: readonly string[]
  unstaged: readonly string[]
  untracked: readonly string[]
  submodules: readonly string[]
  shortStat: Readonly<{
    filesChanged: number
    insertions: number
    deletions: number
  }>
}>

type UnmergedPathsRefusal = Readonly<{
  kind: "unmerged-paths"
  contractId: ContractId
  paths: readonly string[]
}>

type DocumentMovedRefusal = Readonly<{
  kind: "document-moved"
  contractId: ContractId
}>

type TargetInputRefusal =
  | Readonly<{ kind: "invalid-target" }>
  | Readonly<{ kind: "target-missing" }>
  | Readonly<{
      kind: "here-target-mismatch"
      target: string
      branch: string | null
    }>

type VerificationStop =
  | StepStop<AttestationRefusal>
  | Readonly<{ failure: "candidate-unavailable"; diagnostic: string }>
  | Readonly<{
      failure: "environment-failure"
      diagnostic: string
    }>
  | Readonly<{
      failure: "environment-failure"
      command: number
      detail: HookFailure
    }>
  | Readonly<{ failure: "unknown-exit" | "cancelled" }>
  | Readonly<{ failure: "spawn-error"; diagnostic: string }>

type PlacementStop =
  | StepStop<PlacementRefusal | IntegrationRefusal | CheckoutNotFollowableRefusal | DeliveryWorkspaceRefusal>
  | Readonly<{
      failure: "target-moved"
      contractId: ContractId
      target: string
      integratedAt: SnapshotId
      observed: SnapshotId | null
      attempts: number
    }>
  | Readonly<{ failure: "target-placement-failed"; diagnostic: string }>

type VerificationCleanupFailure = Readonly<{
  phase: "destroy"
  command: number
  detail: HookFailure
}>

type VerificationReuse = Readonly<{
  entry: EntryUlid
  verdict: "satisfied" | "unsatisfied"
}>

type CandidateCompletion = Readonly<{
  integration: SnapshotId
  verification?: Readonly<{
    mode: "ran" | "reused"
    verdict: "satisfied" | "unsatisfied"
  }>
}>

type ContinuationReport = Readonly<{
  attempted: number
  claimed: readonly ContractId[]
  stopped: readonly Readonly<{
    contractId: ContractId
    stop: PlacementStop | { kind: "already-terminal" | "delivery-missing" }
  }>[]
}>

type Delivery = Readonly<{
  tenderSnapshot: SnapshotId
  integration: Readonly<{
    predecessor: SnapshotId
    snapshot: SnapshotId
    changeId: ChangeId
  }>
  method: "squash"
  policy: Readonly<{ requireBranchesToBeUpToDate: boolean }>
  completion?: CandidateCompletion
  verification?: VerificationStop
  verificationReuse?: VerificationReuse
  verificationSummary?: string
  placement?: PlacementStop
  cleanup?: VerificationCleanupFailure
  leak?: WorktreeLeak
  continuation?: ContinuationReport
  diff(): Promise<string | null>
}>

type Review = Readonly<{
  completion?: CandidateCompletion
  verification?: VerificationStop
  verificationReuse?: VerificationReuse
  verificationSummary?: string
  placement?: PlacementStop
  cleanup?: VerificationCleanupFailure
  leak?: WorktreeLeak
  continuation?: ContinuationReport
}>
```

`RegionObservation` is structural notation for successful `bind` and `amend`
results, not another package-root export. Exactly one property is present.
`overlaps`, including `[]`, means the observation completed. `overlapFailure`
means admission succeeded but the non-authoritative observation did not
complete; it contains the verbatim diagnostic and does not change the mutation
result. `RegionOverlap` is the only exported Region result type.

The report compares declared write intent to expose likely interaction between
active Contracts. Even though pattern intersection is exact, the report is a
coarse planning signal because Region does not predict the eventual Git diff.
An overlap neither grants nor denies write authority and does not refuse bind
or amend. Small overlaps may proceed under Git's optimistic model and be
resolved manually or by a delegated worker; logical dependency or unsafe
large interaction is represented explicitly with `after`.

The Region report remains a library-edge observation. It is not passed to
protocol, core, or Git, and it never crosses those layers as Region
vocabulary. After admission, the library makes one internal protocol document
read. That read observes Git once, folds every contract, filters
terminal contracts, and returns only `{ contract, documentBytes }`; it neither
decodes a document nor names Region. The library removes self, decodes the
opaque peer bytes through the same body methodology, and computes overlap at
the edge. It never imports Git directly, loops over per-contract `state()`
reads, reuses an admission receipt as a world snapshot, or caches or persists a
second Region value.

Kanshi's optional read-time Region section is separate from this mutation-time
snapshot. It exposes `RegionDeclaration`, `RegionIntersection`,
`RegionPathMatch`, and the `RegionRead` union selected by `KanshiInput.region`;
it carries declarations only and never actual touched paths or Git conflicts.

`amend` exposes `terms-moved` when any source `ContractTerms` value used to
derive its complete replacement no longer matches the attempt observation.
`deliver` and audit's read-only methodology selection expose
`DocumentMovedRefusal` for their key-stamped document derivation. Review receives no decoded-document
derivation and does not expose `document-moved`; its testimony remains keyed to
the subject actually reviewed. `KeiyakuRefusal` therefore includes
`terms-moved` for amend, `DocumentMovedRefusal` for deliver and audit, and
`DeliveryWorkspaceRefusal` for a here deliver whose caller workspace left its
target. It also includes `DirtyWorkspaceRefusal` when delivery lacks explicit
dirty authorization, when dirty submodule internals cannot be sealed or
observed, or when conflict materialization finds a dirty appointed workspace,
including when `includeDirty` is also supplied. Existing Git merge state
during materialization is `MergeStatePresentRefusal`. Ordinary dirty review is
accepted and returns a `workspace`
disclosure instead of a refusal. One path may appear in both staged and
unstaged arrays when the index and worktree each differ. `shortStat` describes
the complete final tree relative to `HEAD`; binary entries count as changed
files with zero textual insertions/deletions. These refusals end the
invocation; they do not trigger a reread, auto-retry, or adoption of a new
document revision.

`UnmergedPathsRefusal` is the delivery and audit refusal for a real index with
unmerged entries. Its `paths` are Git-reported sorted unique complete paths;
it applies with or without `includeDirty`, before candidate or Verification
work. A resolved `MERGE_HEAD` remains ordinary dirty authorization: with
`includeDirty`, its tender snapshot has workspace `HEAD` then `MERGE_HEAD` as
its ordered parents.

`TargetInputRefusal` is the `KeiyakuRefusal` member for `Keiyaku.bind` target
validation, existence, and the targeted-here branch relationship. It has no
contract coordinate because a rejected target establishes no contract
identity.

Every accepted `AmendResult` includes its nonoptional `documentDiff`. The
library computes it exactly once with the JavaScript `diff` package from the
exact whole-document before and after bytes. It is presentation data only: it
is not document-body law, a journal fact, a receipt, cache state, or a gate
input, and it does not cross below the library boundary.

`deliver` may return `IntegrationConflictMaterialized` instead of a
`MutationResult`. That value is the public conflict-handoff result: it has no
journal facts, candidate identity, placement admission, or verification, and
it is not a refusal. `KeiyakuRefusal` still owns the observation-only conflict
failure, which includes `recovery` only on `reason: "conflict"`.

Every successful mutation result contains every fact admitted by that
invocation and the addressed Contract's resulting head scalar. Accepted deliver and
satisfied review additionally carry `completion` exactly when placement admits
`claimed`. Its `integration` is the exact final placed snapshot. Its optional
Verification member binds the final snapshot to whether Verification ran or a
current attestation was reused and to that verdict; it is absent when no
Verification declaration applied. An unsatisfied terminal Verification may
also carry its existing bounded `verificationSummary`, including when a gate
stop leaves placement incomplete. Package-root results expose no `Receipt`,
`prior`, or folded `snapshot`.
Protocol may retain prior and snapshot values while composing one invocation,
but they are process-local implementation data with no public or persistent
reader.

An accepted deliver or review carries `continuation` only when its successful
placement attempted at least one retained dependent. `attempted` is the exact
number attempted in that invocation. `claimed` and `stopped` retain canonical
selection order and complete ContractIds. A stopped row carries the unchanged
`PlacementStop`, or `already-terminal`/`delivery-missing` when concurrent state
movement prevents starting the retained candidate. The report is an
invocation-scoped consequence projection, not a queue, retry receipt, or
journal fact. JSON and text consume this same value without another read.

An unsuccessful trailing obligation does not change the successful leading act.
The `verification` or `placement` channel contains the typed reason why that
obligation admitted no fact. Verification process outcomes and attestation
admission stops share `VerificationStop`; placement admission stops use
`PlacementStop`. In particular, a satisfied review can admit its attestation
and then return a `delivery-missing` placement stop before any delivery exists.
Once a delivery exists, review and delivery share the same reintegration
completion loop. Target movement is represented by admitted `reintegrated`
facts followed by a retry, or by an accepted typed repeated-movement stop after
three complete cycles. Review and delivery share the delivery fact's one
worktree-content ChangeId, while integration coordinates remain placement
topology. The obligations are independent and both channels may be present on
one Delivery. A channel is absent exactly when its obligation was not applicable
or admitted its fact; callers distinguish those cases through `facts`. These
values remain process-local and non-authoritative;
the journal is the sole lifecycle authority. `environment-failure` identifies
candidate provisioning, never a Verification verdict; `candidate-unavailable`
identifies materialization failure; `unknown-exit`, `spawn-error`, and admission
stops remain execution/admission stops. A declaration-owned timeout instead
admits an unsatisfied attestation and therefore has no stop arm.

`prerequisites-unsatisfied` carries a nonempty `unmet` collection exactly as
projected by the placement decision. Its rows retain declared prerequisite
order, each complete ContractId, and one `missing`, `active`, or `abandoned`
category; claimed prerequisites do not appear. Protocol, Library, JSON, and
text consume that same public value without another authority read or lifecycle
derivation.

`KeiyakuRefused` stores the complete structured `KeiyakuRefusal`; its `code`
getter derives from `refusal.kind`. `KeiyakuRetry` does the same for
`KeiyakuRetryReason`. The getters are not second stored discriminants. Callers
can switch exhaustively on `code` and inspect the structured value when the
refusal carries a contract coordinate or the retry carries a diagnostic.
Programmer value-shape errors and authority corruption retain their distinct
exception types.

`KeiyakuRefused` and `KeiyakuRetry` remain reserved for invocations that
admitted no fact. Recoverable post-admission physical and settlement failures
are visible in the successful result's typed lags. The facade never abandons
an admitted Contract as error recovery.

Placement's `target-placement-failed` stop includes a bounded diagnostic for a
failed Git custody observation or target-fence command. It is a pre-publication
mechanical failure, so the target ref, checkout, and claimed fact remain
untouched; it is not an ignored-collision refusal and it is never interpreted
from Git stderr prose by the lifecycle layer.

Retry details are process-local and non-authoritative. Exhaustion and canonical
entry collisions carry no admission, contract, journal, or byte payload. A
known failed atomic transaction carries only `publication-failed` and its
verbatim diagnostic. It does not claim which asserted ref moved; a later
invocation prepares from a fresh observation.

Result identity has one source. A successful bind names the born Contract only
through `keiyaku` and its facts; later mutation results address the handle the
caller already owns. A refusal carries a contract identity only when its
structured refusal concerns an existing contract. A retry never carries
contract identity: it asserts that no new identity was established, and
retrying bind mints a new identity. Adapters keep their addressed input instead
of mining another coordinate from an error.

Library owns bind identity allocation. Four `contract-exists` admissions return
the last typed Protocol refusal; the package root throws `KeiyakuRefused` with
that same refusal. Identity exhaustion is not `KeiyakuRetry` and does not use
the `exhausted` retry reason.

Read-only `ContractWorkspaceObservation` is owned by
[public-api.md](public-api.md); this mutation-results chapter defines no
second read-result shape.

```ts
type AuditWorkspace = Readonly<{ kind: "worktree" | "here"; path: string }>
type DiffScope = Readonly<{
  filesChanged: number
  insertions: number
  deletions: number
  paths?: readonly string[]
}>
type AuditReport = Readonly<{
  candidate:
    | { kind: "blocked"; refusal: DeliveryPreparationRefusal }
    | {
        kind: "ready"
        workspace: AuditWorkspace
        identity: DeliveryIdentity
        scope: DiffScope
        diff?: string
      }
  verification:
    | { kind: "not-run" }
    | { kind: "satisfied"; passed: number; total: number; summary?: string }
    | { kind: "unsatisfied"; passed: number; total: number; summary?: string }
    | { kind: "stopped"; stop: VerificationStop }
  target:
    | { kind: "not-observed" }
    | { kind: "placeable"; ref: string; head: SnapshotId }
    | { kind: "moved"; ref: string; expected: SnapshotId; observed: SnapshotId | null }
    | { kind: "refused"; refusal: TargetPlacementRefusal }
    | { kind: "failed"; diagnostic: string }
  delivery?: { changeId: ChangeId; relation: "identical" | "differs" }
}>
```

`audit()` accepts only an active Contract. A missing or terminal Contract uses
the ordinary top-level refusal before workspace observation, candidate
preparation, Verification, or target adjudication. It returns
`MutationResult<AuditReport>` when that leading judgment and mandatory
reconciliation complete. The report is one already-adjudicated
triple: candidate, Verification, and target. There is no journal timeline,
rework count, preview wrapper, or optional attempt combination. A blocked
candidate produces Verification `not-run` and target `not-observed` and admits
no Verification fact. A ready candidate names the exact prospective identity
and predecessor-to-candidate `DiffScope`, and alone carries the workspace path
that was actually used. An active managed Contract with no Place appointment
returns blocked `worktree-missing`; it carries no workspace field and never
derives a retired or prospective path. `diff` is present only when the
public input requested it, including the empty string; Git-unavailable is not
a public audit arm. Paths appear on `scope` only with that same request.

A successful Verification attestation appears in `facts` and as a terminal
`satisfied` or `unsatisfied` answer with producer-owned `passed` and `total`.
No renderer, protocol reader, or test may parse `summary`, stdout, or stderr
for those counts. A process nonterminal or attestation refusal/retry is
`stopped` and forces target `not-observed`. The target adjudicator runs only
after no declarations or a terminal Verification answer. Movement has
precedence over placeability, including during the followability check. Audit
never places or moves the target.

A leading refusal or retry, such as a missing contract, uses the same
`KeiyakuRefused` or `KeiyakuRetry` rejection as every other public mutation.
None of these cases creates a second observation authority or duplicate
boolean flag. Deliver may expose transient `verificationReuse` naming the
reused attestation entry and verdict; that field is absent when deliver ran
Verification or no declarations applied. `completion` remains the sole
final-placement answer and is never reconstructed from facts or folded state.

Verification may use one process-local disposable worktree. Failure to remove
it after a fact was admitted cannot change the accepted arm, facts, or exit
status. `Delivery.leak` and accepted `MutationResult.leak` report that physical
residue with its path and verbatim diagnostic. Cleanup and leak stay on the
generic accepted result, not on `AuditReport`. They are transient reports, not
journal facts, cleanup authority, or reconcile input.
