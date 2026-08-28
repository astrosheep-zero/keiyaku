# Lifecycle And Protocol

This chapter owns the contract's verb decisions, eligibility, gates,
attestation meaning, and the observe-decide-admit protocol. Facts and folded
values are defined in [model.md](model.md); document syntax is owned at the
library edge by [document.md](document.md).

## Lifecycle

The folded lifecycle is `no journal -> waiting -> bound -> pending delivery ->
claimed | abandoned`. The terminal phase is a derived read model, never another
persisted authority.

A bind records immutable coordinates and the initial opaque contract terms. It
does not admit `bound`; the contract waits for the first operation whose fact
requires boundness. A contract's `after` list is the ordered placement
prerequisite snapshot. Authors declare an edge only when one Contract's result
must ultimately build on another's settled outcome, or when their intended work
has a large or irreconcilable interaction that should be sequenced. Small Region
overlaps do not meet that threshold: Keiyaku uses Git's optimistic write model,
and ordinary conflicts may be resolved manually or by a delegated worker. An
`after` edge does not assert disjoint Regions or forbid all overlap. It cannot
contain the contract itself. An amend replaces the complete opaque terms and
may change `after` at any point before a terminal fact, including after `bound`
or `deliver`. Coordinates never change.

The prerequisite graph is acyclic by construction. Amend refuses
`cyclic-prerequisite` when its resulting `after` reaches the addressed Contract;
bind's fresh identity cannot already be referenced. The judgment reads only the
touched prerequisite closure, and fold never re-adjudicates it.

An explicit placement request uses one placement adjudicator. The adjudicator
admits `claimed` only when every ContractId in the current `after` snapshot is
claimed and every declared gate passes its generic currentness check. A missing
delivery receives `delivery-missing`; an unclaimed prerequisite receives
`prerequisites-unsatisfied`; an unsatisfied gate receives `gates-unsatisfied`.
Both are placement obligations, but `after` remains an identity edge that reads
another Contract's terminal fact while `terms.gates` remains an opaque token
satisfied by current attestation evidence. Placement does not synthesize an
attestation or gate token for a prerequisite.
For `prerequisites-unsatisfied`, that same sole adjudicator projects the
non-claimed direct prerequisites into `unmet`, retaining the declared `after`
order. Each complete ContractId has one observed category: `missing` for a
null observation, `abandoned` for an abandoned terminal, and `active` for every
other non-claimed state. Claimed prerequisites are omitted, and this refusal
always has a nonempty `unmet` collection. No later layer rereads Contract
authority or adjudicates those categories.
For `gates-unsatisfied`, that same sole adjudicator derives a nonempty ordered
`unmet` collection from its one current gate-report projection. Every report
whose current evidence is not an attested satisfied verdict remains in declared
order with its existing attested-unsatisfied, stale, or missing union; current
satisfied reports are omitted. No later layer rereads gate evidence, derives
currency, or replaces these reports with another gate-detail value.
Admitting testimony does not itself invoke placement; `deliver` and a satisfied
`review` explicitly request it as a later protocol step. A successful placement
also continues already-delivered direct dependents whose current prerequisites
are now claimed. Both paths use the same placement adjudicator under the target
fence. If the target moved after the accepted
candidate was prepared, the protocol compares the observed target commit tree
with the offered candidate tree under that same fence and exposes the boolean
`observedTreeEqualsCandidate` on the `target-moved` stop. When true, completion
stops immediately: it does not reintegrate, append a fact, rewrite the target,
publish, or consume a retry cycle. External movement remains `target-moved`,
never `claimed` or an equivalent terminal. When false, the protocol reuses the
persisted tender and frozen policy, admits `reintegrated`, runs or reuses the
exact Verification, and retries placement. It performs at most three complete
integrate-verify-place cycles. A repeated movement stop carries the last
integration snapshot, freshly observed target (or `null` when the ref
disappeared), numeric attempt count, and the same equality boolean. A missing
target is always false.
Audit never invokes placement.

Git owns target followability. Its mechanical stops cannot publish, become
claimed, or change eligibility; failed follow is recoverable lag under
[git-reconciliation.md](git-reconciliation.md), never reversed admission.

`deliver` records the Git-owned candidate and frozen-policy identity; a later
tender replaces it. Current `verified` testimony for that delivery and
Verification segment is reused, whether satisfied or unsatisfied; otherwise
Verification runs. Placement consumes generic current gate evidence.

`deliver` may request conflict materialization. A plain conflict is the typed
`integration-failed` refusal and changes no authority; materialization projects
the judged conflict into the appointed workspace, admits no delivery fact, and
leaves the Contract pending. Continuation while that merge is uncommitted uses
`includeDirty` to capture current worktree bytes; omitted `includeDirty` keeps
the existing dirty-workspace or unmerged-paths refusal. Shared-index `UU` state
alone is not a second conflict judge.
Akuma delivery forwarding creates no second delivery authority.

`review` is a contract operation and may record testimony before any `deliver`.
Git captures its subject as the document key projected by the decision
observation and the ChangeId of the complete reviewable worktree content. This
is not a decoded-document derivation or integration identity, and target
movement alone does not stale the testimony. Its subject has no snapshot
identity. Ordinary dirty workspace bytes do not require review authorization:
the reviewer observes the worktree content in front of it, while delivery
authorization remains owned by `deliver`. If those bytes later become the
delivered candidate, placement proves currentness by the same ChangeId; if they
change or are cleaned away, the review is stale. The reviewed producer boundary
owns the `reviewed` token whether or not it is listed in `terms.gates`.

Review admission records the attestation before a satisfied verdict requests
trailing placement. Before any delivery exists it retains the `delivery-missing`
placement stop. With a delivery present, target movement follows the same
reintegration loop as delivery and never captures new workspace bytes or creates
a second delivery fact. An unsatisfied review records the same subject and
judgment but never requests placement. Optional `summary` is opaque testimony
and does not participate in a gate.

Akuma review forwarding is independently permission-keyed and grants no
delivery authority.

`abandon` admits one `abandoned` terminal fact with `{ note? }`. Optional
`note` remains opaque testimony rather than a gate input. The decision neither
reads nor changes a target ref. Managed-worktree cleanup may return an
invocation-scoped ephemeral recovery snapshot when the captured `HEAD` or
non-ignored workspace tree is not already sealed by Contract facts. That Git
object is neither part of the abandoned fact nor Contract state and may
disappear through ordinary Git garbage collection.

An arc is a narrative chapter within one contract lifetime:

```text
bind -> work -> arc -> work -> arc -> ... -> claimed
```

It names the current chapter of the delivery's story, framing its stage
without splitting delivery, acceptance, settlement, reward, criteria, tasks,
eligibility, or gates. It is not a progress measure and not a task list; a
chapter's contents need not be linear steps. An independently deliverable
slice is a separate contract. Before the first explicit arc, `currentArc`
is absent and readers use the effective contract terms.
The first admitted arc has `seq = 1`; every later arc increments it exactly by
one. The newest arc is `ContractState.currentArc`. Arc is legal before a
terminal fact and otherwise receives a typed refusal.

## Gates And Attestations

Named gate catalog entries in Settings are construction input only. Their
resource and shadow law lives in [settings.md](settings.md). The Contract-owned
`gatesFrom` consumer validates and expands the selected records into the
concrete ordered gate array supplied to bind or amend. Entry names, kinds, and
definitions do not persist. Once admitted, only `terms.gates` matters;
lifecycle and status never read Settings or reconcile an existing Contract
against later configuration edits.

Each `gates` term is an opaque, contract-declared placement obligation. Core
has no built-in gate names, defaults, or verification-derived gates. Its codec
admits the gate-word grammar from [settings.md](settings.md); its placement rule
otherwise stays total and attaches no semantic registry to a word.

The package root accepts the same opaque gate-word grammar and does not close
the vocabulary to its current producers. `Keiyaku.review` produces `reviewed`,
and the declared Verification path reached by `Keiyaku.deliver` or
`Keiyaku.audit` produces `verified`. A custom word may remain unsatisfied until
an existing or future producer records matching testimony; declaring it does
not invent a producer. A producer may still record its own token when it is
absent from `terms.gates`; that testimony is history and does not add a
placement obligation. The declared order is retained as a contract term; gate
satisfaction uses the same generic rule for each declared gate.

`AttestationData` has the shape defined in [model.md](model.md): its `gate` is
an opaque producer token, and its `subject` is a set of core-minted dependency
keys. The producer or operation owns which keys it may lawfully include. Core
does not infer that set from the gate token, document text, or producer kind.

Before producing testimony, an operation captures the dependency-key set it is
lawfully using. Attestation admission records that captured subject, never
re-derives or retargets it, and does not require the subject to remain current.
The pure core attestation adjudicator is the only decision that admits this
testimony. Its lifecycle refusal union is exactly `contract-missing |
terminal`; neither `stale-subject` nor `document-moved` is an attestation
refusal. A testimony about an older subject remains truthful history; placement
alone decides whether the latest testimony for a gate matches the current
subject.

Placement alone applies the generic currentness check for each declared gate:
it reads the latest attestation for the same gate and current subject. Its
`satisfied` verdict satisfies the gate. A later `unsatisfied` verdict for that
same gate and subject overrides the satisfied result. Gate-specific producer
methodology is outside core;
[verification.md](verification.md) owns the execution-side verification case.
The current key set always contains the current document and ordered segment
keys; the delivered tender ChangeId and integration snapshot join it only while
a delivery exists. Tender snapshot identity is custody and observation data,
not gate currency.

The original `deliver` entry remains the stable candidate record. A
`reintegrated` entry records the observed target predecessor and the newly
materialized integration snapshot. Folded `currentIntegration` replaces only
those coordinates and retains the original delivery ChangeId, tender, method,
and policy. `claimed.data.delivery` continues to name the original delivery
entry.

Gate currency has one pure core judgment. Claimed
admission and the public Contract status projection both call that
implementation. The projection reports, in declaration order, whether each
gate has a current attestation, only stale prior testimony, or no testimony;
it also returns the same aggregate satisfaction judgment used by placement.
No protocol adapter, Kanshi join, or renderer reorders attestations, compares
subjects, derives staleness, or infers terminality from phase names.

An invoked producer with no valid producer declaration is rejected by that
producer's owning outer decision. This does not reject a custom gate merely
because no current producer owns it. It is not a preflight readiness check, a
pending journal state, or a journal deadlock. A valid producer declaration may
be executed even when its token is not a placement gate. The package root has
no generic attest operation or gate registry.

## Eligibility

Placement eligibility is a Contract-local projection of that Contract's current
`after` and the terminal state of the ContractIds it names. Bind and amend
observe only their addressed Contract and the finite prerequisite closure
needed to validate identities and acyclicity. Placement observes the addressed
Contract and its current direct prerequisites. After placement admits `claimed`,
the library facade observes active Contracts once, builds an invocation-local
reverse dependency index, and selects direct dependents that retain a delivery
and whose prerequisites are all claimed. This read-time association is not a
Pact decision and does not broadcast `bound` facts. Attestation does not change
prerequisite eligibility.

Every `after` coordinate must resolve to an existing contract in the decision
snapshot. An unresolved coordinate is a typed `unknown-prerequisite` refusal;
v4 does not admit an unfulfillable forward reference. A prerequisite that was
later abandoned remains a real, visible dependency state and is not an unknown
coordinate.

Bind observes its new identity and direct `after` contracts. Amend observes its
identity plus the transitive prerequisite closure of its resulting `after`.
Placement observes its identity plus its current direct `after` contracts.
Deliver does not observe prerequisites. No lifecycle decision performs a
full-world Contract observation.

Prerequisite eligibility becoming true does not itself publish a fact. When it
becomes true because placement admitted `claimed`, that invocation attempts
each selected retained dependent in canonical ContractId order. It reuses the
dependent's persisted tender, frozen policy, Verification, reintegration, and
placement paths; it never captures workspace bytes or appends another delivery.
A managed dependent is first offered a bounded physical baseline follow to the
predecessor's claimed integration snapshot. Git may advance only a detached
dependent worktree whose `HEAD` is an ancestor of that snapshot and whose
tracked, untracked, merge, and conflict state is clean. A refused follow keeps
the dependent active and contributes typed reconciliation lag; it does not
invoke delivery or review again. Existing candidate and review identities are
only re-observed by the continuation's normal placement path.
A child stop does not reverse the leading claim or prevent an independent
sibling attempt. Each newly claimed child exposes its own direct dependents in
the same finite invocation. Acyclic prerequisites and invocation-local
ContractId deduplication make this traversal finite and idempotent. `bound` is
the durable delivery-phase milestone and does not record
consumption of an `after` snapshot. It is materialized only by the first
operation whose fact requires boundness, currently `deliver`, in the same Offer
and immediately before that dependent fact. Bind and amend never eagerly append
it. Future bound gates may be judged at that transition without changing
placement prerequisites. `bound` is never offered or repaired independently,
and no dependent fact may precede it.

The kernel neither sorts nor queues Contracts. Library claim continuation is a
synchronous consequence of one accepted placement, not durable intent: it adds
no queue, retry ledger, event, background worker, or lifecycle fact. Protocol
completes one retained candidate at a time, and the existing placement decision
remains the sole judge of every selected Contract.

## Pact Decisions

Pact owns facts and one pure legal `decide` function per verb. Every attempt
has exactly one immutable decision observation and invokes that function exactly
once. Every value used by that decision either derives from that observation or
enters as a document derivation stamped with the `DocumentKey` it derives from.
The same decision judges that stamp against the observation's current document
key. A mismatch is the lifecycle `document-moved` refusal for a verb that uses
a document derivation.

The operation derives decoded document input inside that attempt's decision
epoch. A publication movement that requires another legal attempt discards the
prior derivation, freezes a fresh decision observation, and derives the input
again. Amend keeps the invocation's initially selected source terms while doing
so; it never retargets the operation document to terms observed by a later
attempt, and the fresh decision returns `terms-moved` when those source terms
are no longer current. The package-root facade performs no document pre-read,
and retry never carries an offer or Git observation from an earlier epoch into
a new decision.

Core owns the shared existence-and-terminal judgment. Amend, deliver,
placement, attestation, abandon, and arc apply it before their verb-specific
rules, returning active state or `contract-missing`/`terminal`. Bind instead
owns `contract-exists`. Protocol, Git, and the library do not repeat this
judgment.

A decision receives plain data, its one observation, and fresh attempt ULIDs.
It returns a typed refusal or an `Offer`; it has no clock, randomness, current
directory, process, callback, decoded document, Git handle, Git effect, or
protocol-body import. The document derivation boundary is defined in
[document.md](document.md).

An `Offer` contains ordered journal appends and expected contract heads. It may
also carry opaque companion tree updates supplied by the package-root
composition boundary. Core decisions never create, decode, or judge those
updates. A claimed placement offer contains a target ref operation only when the contract
declares a target. Its shape is:

```ts
type RefOperation = Readonly<{
  target: string
  expectedOid: SnapshotId
  newOid: SnapshotId
}>

type TreeUpdate = Readonly<{
  path: string
  bytes: Uint8Array
}>

type Offer = Readonly<{
  facts: readonly ContractJournalAppend[]
  target?: RefOperation
  companions?: readonly TreeUpdate[]
}>
```

`target` names the optional reward ref. A targetless placement has no ref
operation.

## Protocol And Admission

Protocol is the sole layer that joins pact decisions to Git observation and
admission. Snapshot identity remains Git-private; pact never names a commit.
Mechanical preparation and the completed decision remain one judge over one
frozen observation, with lifecycle refusal taking precedence over mechanical
failure. Each semantic attempt acquires Git's private-state publication seat
before freezing that observation and holds it through admission; there is no
lifecycle preflight, and retries never reuse preparation.

One decision submits at most one Offer. Git alone constructs objects and
atomically asserts the sealed OIDs; those assertions are the only admission
currentness judge. Placement may wrap the unchanged Offer in the target fence,
which judges physical followability but adds no lifecycle decision. A companion
may add only opaque tree updates derived from the same frozen observation; it
cannot replace facts, target assertions, or the decision and is recomputed on
retry.

After rejection, asserted coordinate movement discards the Offer and starts a
fresh bounded semantic attempt. Three unsuccessful attempts return `exhausted`;
no movement returns `publication-failed`. The publication seat does not change
that bound or make possession an acceptance judgment. Unknown outcomes are
classified only from durable canonical facts: exact entries prove acceptance,
conflicting bytes are collision, and absence permits a fresh attempt.
`document-moved` is returned without automatic retry. The journal is the sole
recovery and handoff receipt.

Amend compares its complete source terms with the current terms and returns
`terms-moved` when they differ. Deliver and audit use stamped document
derivations; review uses the document and patch identity it actually observed
and has no `document-moved` refusal. Later review currency is a gate question.

Audit applies active-contract eligibility before workspace or candidate
observation. Missing, terminal, and moved-document cases are top-level refusals;
candidate preparation failure is accepted `candidate.blocked` with no
Verification fact. Prepared candidates run Verification, and target observation
occurs only after no declarations or a terminal result; stopped Verification
answers `not-observed`. Audit never requests placement, admits claimed, or moves
a target, and admitted `verified` testimony uses the ordinary attestation
decision.

The leading admission selects the outer result. `refused` and `retry` mean no
journal fact landed; once the leading act completes the result remains
`accepted`. Verification, placement, claim continuation, cleanup,
reconciliation, and settlement are independent trailing duties whose facts or
typed stops remain on their own channels. Continuation facts and physical
effects join the invoking result while its `head` remains the addressed
Contract's head. These duties never reverse acceptance, change exit status,
append abandonment, or hide the admitted Contract. Exact public shapes are owned by
[public-results.md](public-results.md).
