# Public Mutation Results

This chapter owns package-root mutation, refusal, retry, and audit result shapes.

## Mutation Results And Errors

Protocol owns its internal three-arm outcome and uses it only to compose an
invocation. The package root does not export that control-flow structure.
Library is the sole public facade: it projects accepted protocol outcomes into
success values, throws typed pre-admission domain failures, and performs the
mandatory post-admission Git reconciliation and settlement before
returning. Post-admission failure is reported as lag without hiding or
rejecting the admitted Contract. CLI calls this same facade; it does not
interpret protocol outcomes or repeat either follow-up stage.

Settlement in this result covers holder-fence release and namespace projection;
it never reports or retries a Task lifecycle write. Held-Task completion is
already part of the reviewed delivery integration.

`MutationResult` is invocation-scoped observation, never Contract state or a
durable receipt. `facts` and `head` come only from accepted protocol admission.
`effects` and `lags` first contain any physical result produced inside targeted
placement's Git fence, then the one mandatory Git reconciliation; `settlement`
comes only from the one settlement invocation. There is no nested `receipt`,
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
    | "prerequisites-already-consumed"
    | "unknown-prerequisite"
    | "cyclic-prerequisite"
  contractId: ContractId
}>

type PlacementRefusal = Readonly<{
  kind: "contract-missing" | "delivery-missing" | "terminal" | "gates-unsatisfied"
  contractId: ContractId
}>

type IntegrationRefusal = Readonly<{
  kind: "integration-failed"
  contractId: ContractId
  reason: "not-based-on-target" | "unrelated-histories" | "conflict"
  targetHead: SnapshotId
  conflictPaths?: readonly string[]
}> | Readonly<{
  kind: "integration-unsupported"
  contractId: ContractId
  requiredGit: "2.38"
}>

type TaskCompletionRefusal = Readonly<{
  kind: "task-completion-refused"
  contractId: ContractId
  taskId: TaskId
  reason: "missing" | "not-a-blob" | "corrupt" | "terminal"
  diagnostic?: string
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

type TaskHolderBindRefusal = Readonly<{
  kind: "task-already-held"
  taskId: TaskId
  holder: ContractId
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
  | StepStop<
      | PlacementRefusal
      | CheckoutNotFollowableRefusal
      | DeliveryWorkspaceRefusal
      | Readonly<{
          kind: "placement-content-moved" | "task-holder-moved"
          contractId: ContractId
          taskId?: TaskId
        }>
    >
  | Readonly<{
      failure: "target-moved"
      contractId: ContractId
      target: string
      expected: SnapshotId
      observed: SnapshotId | null
    }>
  | Readonly<{ failure: "target-placement-failed"; diagnostic: string }>

type VerificationCleanupFailure = Readonly<{
  phase: "destroy"
  command: number
  detail: HookFailure
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
  verification?: VerificationStop
  placement?: PlacementStop
  cleanup?: VerificationCleanupFailure
  leak?: WorktreeLeak
  diff(): Promise<string | null>
}>

type Review = Readonly<{
  placement?: PlacementStop
}>
```

`RegionObservation` is structural notation for successful `bind` and `amend`
results, not another package-root export. Exactly one property is present.
`overlaps`, including `[]`, means the observation completed. `overlapFailure`
means admission succeeded but the non-authoritative observation did not
complete; it contains the verbatim diagnostic and does not change the mutation
result. `RegionOverlap` is the only exported Region result type.

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

`amend` exposes `terms-moved` when any source `ContractTerms` value used to
derive its complete replacement no longer matches the attempt observation.
`deliver` and audit's read-only methodology selection expose
`DocumentMovedRefusal` for their key-stamped document derivation. Review receives no decoded-document
derivation and does not expose `document-moved`; its testimony remains keyed to
the subject actually reviewed. `KeiyakuRefusal` therefore includes
`terms-moved` for amend, `DocumentMovedRefusal` for deliver and audit, and
`DeliveryWorkspaceRefusal` for a here deliver whose caller workspace left its
target. It also includes `DirtyWorkspaceRefusal` when delivery lacks explicit
dirty authorization or when dirty submodule internals cannot be sealed or
observed. Ordinary dirty review is accepted and returns a `workspace`
disclosure instead of a refusal. One path may appear in both staged and
unstaged arrays when the index and worktree each differ. `shortStat` describes
the complete final tree relative to `HEAD`; binary entries count as changed
files with zero textual insertions/deletions. These refusals end the
invocation; they do not trigger a reread, auto-retry, or adoption of a new
document revision.

`TargetInputRefusal` is the `KeiyakuRefusal` member for `Keiyaku.bind` target
validation, existence, and the targeted-here branch relationship. It has no
contract coordinate because a rejected target establishes no contract
identity.

Every accepted `AmendResult` includes its nonoptional `documentDiff`. The
library computes it exactly once with the JavaScript `diff` package from the
exact whole-document before and after bytes. It is presentation data only: it
is not document-body law, a journal fact, a receipt, cache state, or a gate
input, and it does not cross below the library boundary.

Every successful mutation result contains every fact admitted by that
invocation and the resulting contract-head scalar. Successful Verification attestation and
placement therefore appear only in `facts`; their named stop channels are
absent. Package-root results expose no `Receipt`, `prior`, or folded `snapshot`.
Protocol may retain prior and snapshot values while composing one invocation,
but they are process-local implementation data with no public or persistent
reader.

An unsuccessful trailing obligation does not change the successful leading act.
The `verification` or `placement` channel contains the typed reason why that
obligation admitted no fact. Verification process outcomes and attestation
admission stops share `VerificationStop`; placement admission stops use
`PlacementStop`. The obligations are independent and both channels may be
present on one Delivery. A channel is absent exactly when its obligation was
not applicable or admitted its fact; callers distinguish those cases through
`facts`. These values remain process-local and non-authoritative; the journal
is the sole lifecycle authority. `environment-failure` identifies candidate
provisioning, never a Verification verdict; `candidate-unavailable` identifies
materialization failure; `unknown-exit`, `spawn-error`, and admission stops
remain execution/admission stops. A declaration-owned timeout instead admits
an unsatisfied attestation and therefore has no stop arm.

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

```ts
type AuditReport = Readonly<{
  reworks: number
  reviews: number
  timeline: readonly TimelineEntry[]
  delivery?: DeliveryIdentity
  targetObservation?: Readonly<{ head: SnapshotId | null; drift: boolean }>
  attempt?: VerificationStop
  cleanup?: VerificationCleanupFailure
  leak?: WorktreeLeak
}>

type TimelineEntry = Readonly<{
  kind: FactKind
  at: string
  sincePrior: number | null
  attestation?: Readonly<{
    gate: string
    verdict: "satisfied" | "unsatisfied"
    summary?: string
  }>
}>
```

`reworks` counts `deliver` facts and `reviews` counts attestations emitted by
the review operation. Timeline entries are in journal order; `at` is copied from the fact and `sincePrior` is
the integer millisecond difference from the immediately preceding value. The
first entry yields `null`; a negative difference is preserved. Canonical
journal decoding rejects an unparseable timestamp before this projection.
Attestation timeline entries copy their gate, verdict, and optional bounded
summary from that fact. Reports include the current delivery identity and
fresh target observation when available, but no journal entries, body snapshots,
detached raw logs, artifacts, or evidence bytes.

`audit()` returns `MutationResult<AuditReport>` when its leading observation and
mandatory reconciliation complete. A read-only audit and any Verification stop
remain a successful result with zero facts. A successful Verification
attestation appears in `facts`; a process nonterminal or attestation
refusal/retry appears in `report.attempt`. A leading refusal or retry, such as a
missing contract, uses the same `KeiyakuRefused` or `KeiyakuRetry` rejection as
every other public mutation. None of these cases creates a second observation
authority or duplicate boolean flag.

Verification may use one process-local disposable worktree. Failure to remove
it after a fact was admitted cannot change the accepted arm, facts, or exit
status. `Delivery.leak` and `AuditReport.leak` report that physical residue with
its path and verbatim diagnostic. They are transient reports, not journal
facts, cleanup authority, or reconcile input.
