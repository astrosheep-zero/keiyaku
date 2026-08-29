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

This chapter owns the package-root nuke result and refusal shapes. Akuma exact
history uses one Heart-owned nonblank `historyId` for every completed answered
or failed outcome; unknown selectors are typed results and malformed input is
rejected before reading Heart. Reset
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

`MutationResult` is an invocation-scoped answer, never Contract state or a
durable receipt. `facts` and `head` come only from accepted protocol admission.
When claim continuation admits facts for dependent Contracts, `facts` contains
those consequence facts while `head` remains the addressed Contract's head.
Mandatory reconciliation contributes only its `lags`, and Settlement contributes
only `settlementLags`; empty `settlementLags` is the completion judgment. There
is no successful-action collection, hook inventory, nested `receipt`, duplicate
fact field, or result stored on a `Keiyaku` handle.

The identical result is returned after local or forwarded execution. Body
transport serializes that public value directly; it contributes no narrower
receipt value, result projection, or effects collection.

When terminal cleanup creates recovery evidence, `recoverySnapshot` is exactly
the final ref-free `SnapshotId` selected by reconciliation. It is invocation
scoped, has no kind or retention tag, is absent from facts, and may be pruned.

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
  lags: readonly Lag[]
  settlementLags: readonly SettlementLag[]
  recoverySnapshot?: SnapshotId
  cleanup?: VerificationCleanupFailure
  leak?: WorktreeLeak
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

type AmendRegionObservation = Readonly<
  | { overlaps?: never; overlapFailure?: never }
  | { overlaps: readonly RegionOverlap[]; overlapFailure?: never }
  | { overlapFailure: string; overlaps?: never }
>

type AmendResult = Readonly<
  MutationResult<void> &
  AmendRegionObservation &
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

type GateCurrent =
  | Readonly<{
      kind: "attested"
      verdict: "satisfied" | "unsatisfied"
      summary?: string
      at: string
    }>
  | Readonly<{ kind: "stale"; priorVerdict: "satisfied" | "unsatisfied" }>
  | Readonly<{ kind: "missing" }>

type GateReport = Readonly<{
  gate: Gate
  current: GateCurrent
}>

type PlacementRefusal = Readonly<{
  kind:
    | "contract-missing"
    | "delivery-missing"
    | "terminal"
  contractId: ContractId
}> | Readonly<{
  kind: "gates-unsatisfied"
  contractId: ContractId
  unmet: readonly GateReport[]
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
    continue: "deliver --include-dirty"
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
    kind: "worktree"
    path: string
  }>
}>

type IntegrationConflictMaterialized = Readonly<{
  kind: "integration-conflict-materialized"
  targetHead: SnapshotId
  conflictPaths: readonly string[]
  workspace: Readonly<{
    kind: "worktree"
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

type DeliveryPreparationRefusal =
  | Readonly<{ kind: "target-missing" | "worktree-missing"; contractId: ContractId }>
  | DirtyWorkspaceRefusal
  | UnmergedPathsRefusal
  | IntegrationRefusal
  | MergeStatePresentRefusal
  | CheckoutNotFollowableRefusal

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
  | Readonly<{ kind: "unborn-head" }>

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
  | StepStop<PlacementRefusal | IntegrationRefusal | CheckoutNotFollowableRefusal>
  | Readonly<{
      failure: "target-moved"
      contractId: ContractId
      target: string
      integratedAt: SnapshotId
      observed: SnapshotId | null
      attempts: number
      observedTreeEqualsCandidate: boolean
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
  claimed: readonly ContractId[]
  stopped: readonly Readonly<{
    contractId: ContractId
    stop: PlacementStop | { kind: "already-terminal" }
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

`RegionObservation` is structural notation for a successful `bind` result, and
for the Region-observing arms of a successful `amend` result; it is not another
package-root export. A bind and a Region-targeting amend carry exactly one
property. An amend that does not target Region carries neither property. Its
three exclusive shapes are no Region properties, `overlaps`, or
`overlapFailure`. `overlaps`, including `[]`, means the observation completed.
`overlapFailure` means admission succeeded but the non-authoritative
observation did not complete; it contains the verbatim diagnostic and does not
change the mutation result. `RegionOverlap` is the only exported Region result
type.

A successful amend observes Region only when its accepted Markdown operation
document has the normalized `region` changed section: the canonical `Replace:
Region` operation from [document.md](document.md). The body amendment boundary
returns that parser-derived changed-section set with its rendered document, and
the library consults that set after admission and mandatory mutation work.
Structured-only amendments and operation documents targeting another section
perform no Region observation and return neither Region property. This neither
rescans nor reparses Markdown nor compares Region declarations, so an explicit
`Replace: Region` observes even when its replacement patterns are unchanged.

The report compares declared write intent to expose likely interaction between
active Contracts. Even though pattern intersection is exact, the report is a
coarse planning signal because Region does not predict the eventual Git diff.
An overlap neither grants nor denies write authority and does not refuse bind
or amend. Small overlaps may proceed under Git's optimistic model and be
resolved manually or by a delegated worker; logical dependency or unsafe
large interaction is represented explicitly with `after`.

Kanshi's optional read-time Region section is separate from this mutation-time
snapshot. It exposes the three-arm `RegionRead` union selected by
`KanshiInput.region`, including the same `RegionOverlap` shape exported here;
it carries declarations only and never actual touched paths or Git conflicts.

`terms-moved` identifies an amend whose source terms changed. Deliver and audit
use `DocumentMovedRefusal` for a moved stamped document; review has no such
refusal. Delivery also exposes the typed dirty, unmerged, merge-state, target,
and workspace refusals defined above. `unmerged-paths` applies only when
`includeDirty` is omitted; authorized dirty capture does not refuse solely for
shared-index `UU` entries. Ordinary dirty review is accepted with a
workspace disclosure, and these refusals never reread or adopt a new revision.

Every accepted `AmendResult` includes its nonoptional `documentDiff`, which is
presentation data only and does not enter journal, gate, or core state.

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

An accepted deliver or review carries `continuation` only when its successful
placement selects at least one retained dependent. `claimed` and `stopped`
retain canonical selection order and complete ContractIds. A stopped row carries
the unchanged `PlacementStop`, or `already-terminal` when concurrent state
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
completion loop. A `target-moved` stop carries expected and observed target
identities plus `observedTreeEqualsCandidate`, which is true only when the
observed target commit tree exactly equals the offered candidate tree. A true
value is an immediate stop: no `reintegrated` fact, retry, publication, target
rewrite, or claim is emitted. External movement remains `target-moved`, never
`claimed` or `already-applied`; a missing target is false. When false, target
movement is represented by admitted `reintegrated` facts followed by a retry,
or by an accepted typed repeated-movement stop after three complete cycles.
Review and delivery share the delivery fact's one
worktree-content ChangeId, while integration coordinates remain placement
topology. The obligations are independent and both channels may be present on
one Delivery. A channel is absent exactly when its obligation was not applicable
or admitted its fact; callers distinguish those cases through `facts`. These
values remain process-local and non-authoritative; the journal is the sole
lifecycle authority. Environment, candidate, execution, and admission failures
remain typed stops. A declaration-owned timeout admits an unsatisfied
attestation rather than a stop.

`prerequisites-unsatisfied` carries a nonempty `unmet` collection exactly as
projected by the placement decision. Its rows retain declared prerequisite
order, each complete ContractId, and one `missing`, `active`, or `abandoned`
category; claimed prerequisites do not appear. Protocol, Library, JSON, and
text consume that same public value without another authority read or lifecycle
derivation.

`gates-unsatisfied` likewise carries the sole placement decision's nonempty
ordered `unmet` collection. Each existing `GateReport` retains its opaque gate
token and current union: attested verdict with its optional summary and entry
time, stale prior verdict, or missing. Current satisfied reports are omitted.
Protocol, Library, JSON, and text consume those reports unchanged; no later
layer recomputes gate currency or creates a parallel gate-detail value.

`KeiyakuRefused` and `KeiyakuRetry` retain the complete structured value and
derive their machine code from its discriminant. They are reserved for
invocations that admitted no fact; post-admission physical and settlement
failures remain typed lags on the successful result.

Placement failures remain pre-publication typed stops, and retry details remain
non-authoritative. A retry never carries a newly established Contract identity;
bind identity allocation stays at the library boundary.

Read-only `ContractWorkspaceObservation` is owned by
[public-api.md](public-api.md); this mutation-results chapter defines no
second read-result shape.

```ts
type AuditWorkspace = Readonly<{ kind: "worktree"; path: string }>
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
