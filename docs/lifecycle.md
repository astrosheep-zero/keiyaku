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

An explicit placement request uses one placement adjudicator. The adjudicator
admits `claimed` only when every declared gate passes its generic currentness
check. Producing testimony alone never invokes placement, and audit never
invokes placement.

`deliver` tenders the selected current snapshot. Its fact records the observed
predecessor, candidate, and patch identity. A later tender replaces the current
delivery on the read model. The tender's transport preparation and target
update rules live in
[transport.md](transport.md).

An attestation-producing operation records testimony for its declared opaque
gate. A satisfied operation may be the explicit placement request that
completes the declared gates. An unsatisfied operation records judgment only.
Optional `summary` is opaque testimony and does not participate in a gate.

`abandon` records a legal terminal withdrawal. Optional `note` is opaque
testimony and does not participate in a gate. No reason enum is stored: the
fact kind already states the withdrawal intent, and no lifecycle reader needs
a second classification.

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

Each `gates` term is an opaque, contract-declared token. There are no built-in
gate names, defaults, or verification-derived gates in core. The declared order
is retained as a contract term; gate satisfaction uses the same generic rule for
each declared gate.

`AttestationData` has the shape defined in [model.md](model.md): its `gate` is
one declared opaque token, and its `subject` is a set of core-minted dependency
keys. The producer or operation owns which keys it may lawfully include. Core
does not infer that set from the gate token, document text, or producer kind.

Before producing testimony, an operation captures the current key set it is
lawfully using. Admission compares that captured set with the current set for
the same declared keys. A mismatch is the typed `stale-subject` refusal with
the expected and actual keys; admission never retargets a captured subject.
The pure core attestation adjudicator is the only decision that admits this
testimony.

For each declared gate, the generic currentness check reads the latest
attestation for the same gate and subject. Its `satisfied` verdict satisfies
the gate. A later `unsatisfied` verdict for that same gate and subject overrides
the satisfied result. Gate-specific producer methodology is outside core;
[verification.md](verification.md) owns the execution-side verification case.

A gate whose producer has no valid declaration is rejected at that producer's
owning outer boundary. It is not represented as a pending journal state or a
journal deadlock.

## Eligibility

Only an offer containing an eligibility-changing fact reevaluates observed
contracts in the same snapshot. The eligibility-changing facts are `bind`,
`amend`, and `claimed` from an explicit placement request. The offer appends
every newly eligible `bound` fact before dependent facts, in one ordered atomic
offer. An attestation does not change eligibility.

The kernel neither sorts, queues, nor automatically reorders contracts.
Eligibility observes the declared prerequisite identities and their terminal
facts.

## Pact Decisions

Pact owns facts and one pure `decide` function per verb. Its inputs are plain
data, one same-snapshot observation, and fresh attempt ULIDs. A decision returns
a typed refusal or an `Offer`; it has no clock, randomness, current directory,
process, callback, Git handle, or carrier effect.

An `Offer` contains ordered journal appends and expected contract heads. A
claimed placement offer contains a target ref operation only when the contract
declares a target. Its shape is:

```ts
type RefOperation = Readonly<{
  target: string
  expectedOid: SnapshotId
  newOid: SnapshotId
}>
```

`target` names the optional reward ref. A targetless placement has no ref
operation.

## Protocol And Admission

Protocol is the sole layer that joins pact decisions to carrier observation and
admission. Semantic decisions and admission checks use exactly one carrier
snapshot. `ContractsObservation.carrierSnapshot` names the snapshot captured
with the contract map; pact does not name it after a Git commit.

A protocol run observes, decides, submits the offer, and interprets the carrier
outcome. Carrier admission owns raw Git object construction and one atomic
`update-ref --stdin --no-deref` operation. It does not parse Git prose. Known
outcomes are terminal for that attempt. Only typed `unknown` may be probed and
reused under the transport observation rule.

A bounded run has one initial decision and at most two semantic redecisions.
The caller supplies fresh attempt context for each attempt; admission alone
decides whether a fact was accepted. Budget exhaustion returns the typed retry
outcome.

Accepted facts are recognized by canonical entry ULIDs and canonical bytes.
Unknown-admission and process recovery observe durable facts and decide again.
The journal remains the only recovery and handoff authority. A process-local
accepted-operation return cannot become a second receipt authority; this
chapter intentionally specifies no composite receipt shape.
