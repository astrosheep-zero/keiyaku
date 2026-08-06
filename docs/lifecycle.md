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
check. Admitting testimony does not itself invoke placement; `deliver` and a
satisfied `review` explicitly request it as a later protocol step. Audit never
invokes placement.

`deliver` tenders the selected current worktree content. Its fact records the
observed predecessor, candidate, and patch identity. A later tender replaces
the current delivery on the read model. The tender's transport preparation and
target update rules live in
[transport.md](transport.md).

`review` is a contract operation and may record testimony before any `deliver`.
It captures the current worktree patch identity and the effective document key;
its subject has no candidate identity. The reviewed producer boundary owns the
`reviewed` token whether or not it is listed in `terms.gates`. A satisfied
review requests placement; an unsatisfied review records judgment only.
Optional `summary` is opaque testimony and does not participate in a gate.

`abandon` admits one `abandoned` terminal fact with `{ finalHead, note? }`.
Optional `note` remains opaque testimony rather than a gate input.

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

Each `gates` term is an opaque, contract-declared placement obligation. Core
has no built-in gate names, defaults, or verification-derived gates. The
Keiyaku library edge may recognize its `reviewed` and `verified` producer
vocabulary; those names remain tokens supplied to core, not core cases. A
producer may still execute and record an attestation for its token when the
token is absent from `terms.gates`; that testimony is history and does not add
a placement obligation. The declared order is retained as a contract term;
gate satisfaction uses the same generic rule for each declared gate.

`AttestationData` has the shape defined in [model.md](model.md): its `gate` is
an opaque producer token, and its `subject` is a set of core-minted dependency
keys. The producer or operation owns which keys it may lawfully include. Core
does not infer that set from the gate token, document text, or producer kind.

Before producing testimony, an operation captures the dependency-key set it is
lawfully using. Attestation admission records that captured subject without a
freshness check and never retargets it. This permits testimony before delivery.
The pure core attestation adjudicator is the only decision that admits this
testimony. Its refusal union is exactly `contract-missing | terminal`;
`stale-subject` is not a v4 refusal.

Placement alone applies the generic currentness check for each declared gate:
it reads the latest attestation for the same gate and current subject. Its
`satisfied` verdict satisfies the gate. A later `unsatisfied` verdict for that
same gate and subject overrides the satisfied result. Gate-specific producer
methodology is outside core;
[verification.md](verification.md) owns the execution-side verification case.

A declared gate whose producer has no valid declaration is rejected at that
producer's owning outer boundary. It is not represented as a pending journal
state or a journal deadlock. A valid producer declaration may be executed even
when its token is not a placement gate. The v4 `verified` producer uses the v3
Verification section; other producer tokens are edge-owned extensions, not
core vocabulary.

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

A protocol run observes, decides, submits one offer, and interprets the carrier
outcome. Each admission step receives its own fresh observation; a multi-step
operation never pretends those observations are one snapshot. Carrier admission
owns raw Git object construction and one atomic
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

`deliver` and `review` are composed operations, not generic lifecycle runners.
Their first admission is the legal verb step. Only that step controls the outer
accepted/refused/retry outcome. Later verification or placement admissions are
named incidental steps: accepted facts join the same process-local receipt;
refusal or retry stops are reported in the verb value without changing the
outer accepted outcome. The exact public shapes are owned by
[public-api.md](public-api.md).
