# Lifecycle And Protocol

This chapter owns the contract's verb decisions, eligibility, gates,
attestation meaning, and the observe-decide-admit protocol. Facts and folded
values are defined in [model.md](model.md); document syntax is owned at the
library edge by [document.md](document.md).

## Lifecycle

The folded lifecycle is:

```text
no journal -> waiting for bound -> bound -> pending delivery -> claimed
                                      \-> abandoned
```

`claimed` and `abandoned` are terminal. The phase is a derived read model over
facts, never another persisted authority.

A bind records immutable coordinates and the initial opaque contract terms. It
may admit `bound` in the same offer when every declared prerequisite is already
claimed; otherwise the contract is waiting. A contract's `after` list is an
ordered prerequisite snapshot. It cannot contain the contract itself. An amend
replaces the complete opaque terms and may change `after` only before a `bound`
fact has consumed prerequisites; otherwise it receives the typed
`prerequisites-already-consumed` refusal. Coordinates never change.

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
admits `claimed` only when every declared gate passes its generic currentness
check. Admitting testimony does not itself invoke placement; `deliver` and a
satisfied `review` explicitly request it as a later protocol step. Audit never
invokes placement.

For a targeted offer, Git's checked-out-target preconditions are part of that
same placement attempt. `checkout-not-followable` is a typed mechanical
refusal from the target fence, not a lifecycle judgment or post-admission lag.
It admits no `claimed` fact and moves no target ref. A completed targeted
placement returns its checkout effects with the accepted step. Once the atomic
ref transaction is accepted it cannot be reinterpreted as a refusal: a follow
failure is returned as the recoverable physical lag defined by
[git.md](git.md), and process death can leave that same recovery shape.

`deliver` tenders the selected current worktree content. Before admitting the
fact, Git materializes the complete integration candidate that this attempt may
verify and place. The fact records the tender snapshot, integration
predecessor, integration snapshot, integration ChangeId, squash method, and the
attempt's frozen up-to-date policy. A later tender replaces the current
delivery on the read model. The tender and integration preparation rules live
in [git.md](git.md).

`review` is a contract operation and may record testimony before any `deliver`.
It uses Git's compute-only integration projection to capture the ChangeId that
the current target and worktree bytes produce, plus the document key projected
by its decision observation; this is not a decoded-document derivation. Its
subject has no snapshot identity. The reviewed producer boundary owns the
`reviewed` token whether or not it is listed in `terms.gates`. A satisfied
review requests placement; an unsatisfied review records judgment only.
Optional `summary` is opaque testimony and does not participate in a gate.

`abandon` admits one `abandoned` terminal fact with `{ note? }`. Optional
`note` remains opaque testimony rather than a gate input. The decision neither
reads nor changes a target ref.

An arc is a narrative chapter within one contract lifetime:

```text
bind -> work -> arc -> work -> arc -> ... -> claimed
```

It marks the next coherent unit of progress without splitting delivery,
acceptance, settlement, reward, criteria, tasks, eligibility, or gates. An
independently deliverable slice is a separate contract. Before the first
explicit arc, `currentArc` is absent and readers use the effective contract
terms.
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
keys; integration snapshot and ChangeId keys join it only while a delivery
exists. Tender identity is custody and observation data, not gate currency.

Gate currency has one implementation in `core/facts/gate.ts`. Claimed
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

Eligibility is recomputed for exactly the contracts a fact can affect. A
`bind` or `amend` offer judges only its own contract, observing the contracts
named by its resulting `after` set. A `claimed` offer judges every contract in
the same snapshot because it may make any contract that names the claimed one
eligible. An attestation does not change eligibility.

Every `after` coordinate must resolve to an existing contract in the decision
snapshot. An unresolved coordinate is a typed `unknown-prerequisite` refusal;
v4 does not admit an unfulfillable forward reference. A prerequisite that was
later abandoned remains a real, visible dependency state and is not an unknown
coordinate.

Bind observes its new identity and direct `after` contracts. Amend observes its
identity plus the transitive prerequisite closure of its resulting `after`.
Claimed placement remains the only full-world eligibility observation.

A `bound` entry is admitted atomically with the fact that made the contract
eligible, under that fact's decision snapshot. The triggering fact is the
contract's own `bind` or `amend`, or a prerequisite's `claimed` fact. `bound`
is never offered or repaired independently. The ordered offer places every
newly eligible `bound` entry before facts that depend on it.

The kernel neither sorts, queues, nor automatically reorders contracts.
Eligibility observes the declared prerequisite identities and their terminal
facts.

## Pact Decisions

Pact owns facts and one pure legal `decide` function per verb. Every attempt
has exactly one immutable decision observation and invokes that function exactly
once. Every value used by that decision either derives from that observation or
enters as a document derivation stamped with the `DocumentKey` it derives from.
The same decision judges that stamp against the observation's current document
key. A mismatch is the lifecycle `document-moved` refusal for a verb that uses
a document derivation.

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

The one decision submits at most one offer. Git admission owns raw Git
object construction and one atomic `update-ref --stdin --no-deref` operation;
it does not parse Git prose. Admission's expected-head assertions remain the
only currentness adjudicator for that offer.

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

After a known rejected transaction, protocol compares the Git and optional
target ref with the coordinates asserted by that attempt. Any movement discards
the offer; the next bounded semantic attempt observes, folds, and decides
afresh. A newly
ineligible state returns that decision's typed refusal. Three
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

Audit has two mutually exclusive arms. A read-only report arm may project
`contract-missing` or `document-moved` from its sole observation because it
admits no fact and has no later legal decision. When audit attempts to admit a
Verification attestation, protocol performs no admission-side lifecycle
pre-judgment: the captured preparation enters `decideAttestation`, whose
attempt observation solely decides contract existence and terminal state. No
`decideAuditEligibility` or protocol fast path exists.

A composed operation has one leading act: the invoked verb's own journal
admission for bind, amend, deliver, review, abandon, and arc, and the observation
report for audit. That leading act alone selects the outer outcome arm.
`refused` and `retry` assert that this invocation landed no journal fact. Once
the leading act completes, the outcome is irrevocably `accepted`; no trailing
result may flip it.

Trailing obligations are independent domain duties, not a short-circuiting
pipeline. Running a valid Verification, admitting its attestation, and
attempting placement occur in that fixed order, and every applicable obligation
runs even when an earlier one stops without a fact. Their only communication is
through admitted facts. A trailing fact joins the accepted outcome's `facts`;
a trailing refusal, retry, or nonterminal process result appears on that
obligation's own presence-discriminated stop channel. The channels are
independent, so one invocation may expose both Verification and placement
stops. Placement reads only declared gates against admitted attestations:
whether `verified` is declared decides what placement waits for, never whether
the producer runs. The exact public shapes are owned by
[public-api.md](public-api.md).

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
