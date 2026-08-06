# Lifecycle And Protocol

This chapter owns the contract's verb decisions, eligibility, gates, review
meaning, and the observe-decide-admit protocol. Facts and folded values are
defined in [model.md](model.md); document syntax is defined in
[document.md](document.md).

## Lifecycle

The folded lifecycle is:

```text
no journal -> waiting for bound -> bound -> pending delivery -> claimed
                                      \-> abandoned
```

`claimed` and `abandoned` are terminal. The phase is a derived read model over
facts, never another persisted authority.

A bind records immutable coordinates and the initial complete body. It may
admit `bound` in the same offer when every declared prerequisite is already
claimed; otherwise the contract is waiting. A contract's `after` list is an
ordered prerequisite snapshot. It cannot contain the contract itself. An amend
replaces the complete body and may change `after` only before a `bound` fact
has consumed prerequisites; otherwise it receives the typed
`prerequisites-already-consumed` refusal. Coordinates never change.

An explicit placement request from `deliver`, or from a satisfied `review` that
satisfies the required gates, uses one placement adjudicator. The adjudicator
admits `claimed` only when its current gate read is satisfied. A successful
verification result by itself never invokes placement, and audit never invokes
placement.

`deliver` tenders the selected current snapshot. Its fact records the observed
predecessor, candidate, and patch identity. A later tender replaces the current
delivery on the read model. The tender's transport preparation and target
update rules live in
[transport.md](transport.md).

`review` produces a `reviewed` attestation. A satisfied review may be the
explicit placement request that completes the gates. An unsatisfied review
records judgment only. Optional `summary` is opaque testimony and does not
participate in a gate.

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
explicit arc, `currentArc` is absent and readers use the contract body itself.
The first admitted arc has `seq = 1`; every later arc increments it exactly by
one. The newest arc is `ContractState.currentArc`. Arc is legal before a
terminal fact and otherwise receives a typed refusal.

## Gates And Attestations

The gate vocabulary is `reviewed` and `verified`. The effective required set is:

| Declaration | Effective required set |
| --- | --- |
| omitted | `[reviewed]` |
| `[]` | no review gate |
| ordered `reviewed`/`verified` array | exactly that declaration |
| nonempty Verification declaration | add `verified` if absent |

The `gates` option supplies a frozen ordered snapshot to the complete body.
Settings names and document grammar are not gate authority. A Verification
declaration always requires `verified`.

`AttestationData` has this exact shape:

| Field | Shape | Rule |
| --- | --- | --- |
| `gate` | `reviewed` or `verified` | required gate producer |
| `subject` | `SubjectKey` | constructed only by core from current state and gate |
| `verdict` | `satisfied` or `unsatisfied` | required judgment |
| `summary` | nonblank string, optional | compact testimony |

`src/core/subject.ts` is the one subject constructor. Its
`currentSubject(state, gate)` returns no subject until the state has a current
delivery and body. A `reviewed` subject uses the current delivery candidate,
its `deliveryPatchId`, and the complete current-body key. A `verified` subject
uses the current delivery candidate and current effective Verification
declaration key. Thus an amendment to any body field invalidates a reviewed
attestation, while an amendment unrelated to Verification does not invalidate
a verified attestation.

Review and Verification producers capture their `AttestationData.subject`
before testimony or execution. Admission compares that captured subject with
`currentSubject(state, data.gate)`; a mismatch is the typed `stale-subject`
refusal with `expected` and `actual` keys. Admission never replaces a captured
subject with a newly computed one. The pure core attestation adjudicator is the
only decision that admits either producer's testimony.

For each gate, `gate.ts` derives the current subject and reads only the latest
attestation with that same gate and subject. Its `satisfied` verdict satisfies
the gate; a later `unsatisfied` verdict supersedes it. Verification production
and its runtime behavior are defined in [verification.md](verification.md).

## Eligibility

Only an offer containing an eligibility-changing fact reevaluates observed
contracts in the same snapshot. The eligibility-changing facts are `bind`,
`amend`, and `claimed` from an explicit placement request. The offer appends
every newly eligible `bound` fact before dependent facts, in one ordered atomic
offer. A verified attestation does not change eligibility.

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

Accepted facts are recognized by canonical entry ULIDs and canonical bytes. On
unknown-admission recovery, an accepted Receipt retains the pre-admission fold
that supplied the winning offer as `prior`. Process recovery observes durable
facts and decides again. The process-local handoff is an optimization only; no
attempt or handoff ledger is durable authority.
