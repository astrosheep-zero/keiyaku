# Lifecycle And Protocol

This chapter owns the contract's verb decisions, eligibility, gates,
attestation meaning, and the observe-decide-admit protocol. Facts and folded
values are defined in [model.md](model.md); document syntax is owned at the
library edge by [document.md](document.md).

## Lifecycle

The folded lifecycle is:

```text
no journal -> waiting -> bound -> pending delivery -> claimed
                      \-> abandoned
```

`claimed` and `abandoned` are terminal. The phase is a derived read model over
facts, never another persisted authority.

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

The prerequisite graph is acyclic by construction. An amend whose resulting
`after` would make the contract reachable from its own transitive prerequisite
closure is refused as `cyclic-prerequisite`. Bind cannot create a cycle: a
freshly minted identity is referenced by no existing `after`. Because every
admission preserves acyclicity, the reachability judgment traverses only the
prerequisite closure touched by the amendment; it needs neither a reverse index
nor a full-world observation. Protocol assembles that closure, while
`decideAmend` remains the sole legal judge. Fold does not re-adjudicate graph
acyclicity.

An explicit placement request uses one placement adjudicator. The adjudicator
admits `claimed` only when every ContractId in the current `after` snapshot is
claimed and every declared gate passes its generic currentness check. A missing
delivery receives `delivery-missing`; an unclaimed prerequisite receives
`prerequisites-unsatisfied`; an unsatisfied gate receives `gates-unsatisfied`.
Both are placement obligations, but `after` remains an identity edge that reads
another Contract's terminal fact while `terms.gates` remains an opaque token
satisfied by current attestation evidence. Placement does not synthesize an
attestation or gate token for a prerequisite.
Admitting testimony does not itself invoke placement; `deliver` and a satisfied
`review` explicitly request it as a later protocol step. That request is one
target-fence placement attempt: a present delivery is judged as-is, and only a
still-missing delivery may attach a typed integration stop. Audit never invokes
placement.

For a targeted offer, Git's checked-out-target preconditions are part of that
same placement attempt. `checkout-not-followable` is a typed mechanical
refusal from the target fence, not a lifecycle judgment or post-admission lag.
It admits no `claimed` fact and moves no target ref. A completed targeted
placement returns its checkout effects with the accepted step. Once the atomic
ref transaction is accepted it cannot be reinterpreted as a refusal: a follow
failure is returned as the recoverable physical lag defined by
[git-reconciliation.md](git-reconciliation.md), and process death can leave
that same recovery shape.

The target fence first asks Git's `read-tree --dry-run -m -u` whether each
ordinary checkout can follow the predecessor-to-candidate merge. It then
protects only ignored local bytes inside the candidate's physical destruction
scopes. A stream, spawn, or nonzero-exit failure while making that observation
is a mechanical `target-placement-failed` stop; it cannot publish or become a
claimed fact. The custody observation never changes lifecycle eligibility and
does not replace Git's dry-run judge.

`deliver` tenders the selected current worktree content. Before admitting the
fact, Git materializes the complete integration candidate that this attempt may
verify and place. The fact records the tender snapshot, integration predecessor
and snapshot, the tender's one worktree-content ChangeId, squash method, and
the attempt's frozen up-to-date policy. A later tender replaces the current
delivery on the read model. After admission, deliver asks the Verification protocol owner, which
uses the one generic currentness implementation, for latest `verified`
evidence. If that attestation names the exact delivered snapshot and current
Verification segment, satisfied or unsatisfied, deliver does not execute the
declarations again and exposes a transient `verificationReuse` observation.
Otherwise it runs Verification. Placement consumes only generic current gate
evidence. The
tender and integration preparation rules live in [git.md](git.md).

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
trailing placement. Git may find that the target cannot integrate the reviewed
content; that is a typed placement stop on the accepted review, with no claimed
or delivery fact, not an attestation refusal. An unsatisfied review records the
same subject and judgment but never requests placement. Optional `summary` is
opaque testimony and does not participate in a gate.

`abandon` admits one `abandoned` terminal fact with `{ note? }`. Optional
`note` remains opaque testimony rather than a gate input. The decision neither
reads nor changes a target ref.

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

Named gate snapshots in Settings are construction input only. Their resource
and shadow law lives in [settings.md](settings.md). The Contract-owned
`gatesFrom` consumer validates a selected record and produces the concrete
ordered gate array supplied to bind or amend. Once admitted, only
`terms.gates` matters; lifecycle and status never read Settings or reconcile an
existing Contract against later configuration edits.

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
Contract and its current direct prerequisites. Claim concerns only the claimed
Contract; it neither discovers dependents nor broadcasts `bound` facts.
Attestation does not change prerequisite eligibility.

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

Prerequisite eligibility becoming true does not itself publish a fact. Claimed
terminality cannot revert, so the truth remains available for a later placement
attempt. `bound` is the durable delivery-phase milestone and does not record
consumption of an `after` snapshot. It is materialized only by the first
operation whose fact requires boundness, currently `deliver`, in the same Offer
and immediately before that dependent fact. Bind and amend never eagerly append
it. Future bound gates may be judged at that transition without changing
placement prerequisites. `bound` is never offered or repaired independently,
and no dependent fact may precede it.

The kernel neither sorts, queues, nor automatically reorders contracts.
Placement eligibility observes the declared prerequisite identities and their
terminal facts.

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

Core owns one `activeContract` guard for the shared existence-and-terminal
law. Amend, deliver, placement, attestation, abandon, and arc begin their legal
decision with that guard and then apply only their verb-specific rules. The
guard returns the active state or the typed `contract-missing` or `terminal`
refusal for the addressed contract. Bind does not use it because bind owns the
opposite `contract-exists` law. Protocol, Git, and the library do not
repeat this lifecycle judgment as a pre-check, base class, middleware, or
runner.

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
admission. Its decision projection contains only the readers of that one legal
decision. Snapshot identity remains Git-private; pact does not name a
Git commit.

An attempt may be staged as one state-only projection, mechanical preparation,
and a completed `decide`, but those stages remain one judge: the state-only
stage produces no readiness verdict, preparation produces only mechanical
facts, and the completed `decide` consumes the original decision observation.
There is no lifecycle preflight. The core `Preparation` union is the one
mechanical result shape; operations whose fact claims the current document use
the core `StampedPreparation` union. Attestations use ordinary `Preparation`
because their captured subject already names exactly what was judged. A document or other lifecycle refusal from the
completed decision takes priority over a mechanical preparation failure.
Bind coordinate preparation is one such stage: every semantic attempt derives
its complete `BindInput` from current Git facts, and admission atomically
asserts exactly the ref OID sealed into its coordinates. A targeted `here`
branch mismatch is an eligibility refusal of that fresh observation, not an
admission currentness fact. Collision and CAS retries never reuse an earlier
bind preparation.

The one decision submits at most one offer. Git admission owns raw Git
object construction and one atomic `update-ref --stdin` operation; it does not
parse Git prose. Admission's non-mutating expected-OID assertions remain the
only currentness adjudicator for the facts sealed into that offer. Eligibility
observations do not enlarge that assertion scope.

Placement alone may wrap that decided offer in the Git target fence. The fence
does not make another legal decision: it checks only whether a registered
checkout can physically follow the offered predecessor-to-candidate movement,
then publishes the unchanged offer and performs that follow. A physical
refusal returns the Git-owned `checkout-not-followable` value. Protocol does
not publish first and reinterpret checkout state afterward.

An optional companion decorator runs after that attempt's pure decision and before
admission. It receives the exact immutable Git observation used by the attempt
and may only add companion updates; it cannot replace journal entries, target
assertions, or the decision. A retry re-runs the decorator from the fresh
observation, so a stale companion can never be replayed against a newer Git
root.
If a companion introduces a path outside the decision's initially selected
paths, Protocol asks Git to extend only that path's ancestor directories from
the same frozen tree. The decorator still neither reads Git nor becomes a tree
authority.

After a known rejected transaction, protocol compares the Git and optional
target ref with the coordinates asserted by that attempt. Any movement discards
the offer; the next bounded semantic attempt observes, folds, and decides
afresh. A newly ineligible placement returns that decision's typed refusal. Three
unsuccessful semantic attempts return `exhausted`; a rejection with no asserted
coordinate movement remains `publication-failed` with its diagnostic. This
classification reads no Git prose and never turns a failed CAS into acceptance.

A typed `unknown` probes durable facts. Exact canonical entries prove
acceptance, conflicting bytes report collision, and absence discards the old
offer for a fresh semantic attempt. A `document-moved` refusal returns to the
caller and is not auto-retried by the library or protocol.

The journal is the only recovery and handoff authority. A process-local
accepted-operation return cannot become a second receipt authority; this
chapter intentionally specifies no composite receipt shape.

`deliver`, `review`, and `audit` are composed operations, not generic lifecycle
runners. `amend` carries the complete source `ContractTerms` from which it
derived its complete replacement. Its decision compares those opaque document,
segment, gate, and prerequisite values with the current terms and returns
`terms-moved` when any changed; unrelated facts do not stale it. `deliver` and
`audit` use the stamped document derivation
defined in [document.md](document.md). `review` receives no decoded-document
derivation and has no `document-moved` refusal. Its captured subject names the
document and patch identities it actually reviewed; later currentness is a gate
question, not an admission condition.

Audit's leading act applies the shared `activeContract` guard before observing
workspace state, deriving the current document, or preparing a candidate.
Missing and terminal Contracts remain top-level refusals; audit never inspects
a released Place or prospective delivery after claim or abandonment. An active
Contract then prepares a prospective delivery with the same `prepareDelivery`
path as deliver. A moved document remains a top-level refusal.
Candidate-preparation failures are accepted `candidate.blocked` observations
and admit no Verification fact. A prepared candidate runs Verification against
its integration snapshot. The target adjudicator runs only after no
declarations or a terminal Verification answer; stopped Verification answers
`not-observed`. Audit never requests placement, admits claimed, or moves a
target. When audit admits a `verified` attestation, the captured preparation
still enters `decideAttestation`; protocol does not add a second lifecycle
judgment. No `decideAuditEligibility` exists.

A composed operation has one leading act: the invoked verb's own journal
admission for bind, amend, deliver, review, abandon, and arc, and the accepted
three-answer audit report for audit. That leading act alone selects the outer outcome arm.
`refused` and `retry` assert that this invocation landed no journal fact. Once
the leading act completes, the outcome is irrevocably `accepted`; no trailing
result may flip it.

Trailing obligations are independent domain duties, not a short-circuiting
pipeline. After a delivery fact lands, deliver either reuses a now-current
`verified` attestation or runs Verification, then attempts placement. Every
applicable obligation runs even when an earlier one stops without a fact. Their only communication is
through admitted facts. A trailing fact joins the accepted outcome's `facts`;
a trailing refusal, retry, or nonterminal process result appears on that
obligation's own presence-discriminated stop channel. The channels are
independent, so one invocation may expose both Verification and placement
stops. Placement reads the current `after` snapshot and declared gates against
admitted facts: whether `verified` is declared decides what placement waits for,
never whether the producer runs. The exact public shapes are owned by
[public-results.md](public-results.md).

Admission alone controls a composed operation's outer outcome. Physical
cleanup after an accepted admission never throws over that result, changes its
arm, or changes its exit status. A caller may receive the transient residue
report defined by the owning public surface, but cleanup is not lifecycle
authority and does not create a journal, recovery, or reconcile duty.

After protocol admission, the public facade runs mandatory Git
reconciliation and [settlement](settlement.md). Their failures are typed lags
on the successful public result, never a different lifecycle outcome. They do
not change the protocol result to `refused` or `retry`, automatically append an
`abandoned` fact, or hide the admitted Contract identity.
