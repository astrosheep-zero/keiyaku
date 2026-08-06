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

An explicit placement request from `deliver`, or from an approved `review` that
satisfies the required gates, uses one placement adjudicator. The adjudicator
admits `claimed` only when its current gate read is satisfied. A successful
verification result by itself never invokes placement, and audit never invokes
placement.

`deliver` tenders the selected current snapshot. Its fact records the observed
predecessor, candidate, and patch identity. Admission returns typed
`stale-tender` when a later tender replaced the current one. The tender's
transport preparation and target update rules live in
[transport.md](transport.md).

`review` records judgment about one Delivery's patch identity. An approved
review may be the explicit placement request that completes the gates.
`changes-requested` records judgment only. Optional `summary` is opaque
testimony and does not participate in a gate.

`abandon` records a legal terminal withdrawal. Its `reason` is `manual` or
`bind-failed`; optional `note` is opaque testimony and does not participate in
a gate.

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

## Gates And Review Freshness

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

`ReviewData` has this exact shape:

| Field | Shape | Rule |
| --- | --- | --- |
| `verdict` | `approved` or `changes-requested` | required judgment |
| `reviewedPatchId` | `ChangeId` | copied from the current tender |
| `reviewedHead` | `SnapshotId` | copied from the current tender candidate |
| `summary` | nonblank string, optional | compact testimony |

The latest review whose `reviewedPatchId` matches the current tender's
`ChangeId` is authoritative for the `reviewed` gate. A later
`changes-requested` verdict supersedes an earlier approval for the same patch.

`verified` is satisfied only by a matching `VerificationData` fact with
`result: "pass"` for both the current tender candidate and the current
effective Verification declaration key. A changed candidate or declaration key
therefore requires a fresh result. Verification production and its runtime
behavior are defined in [verification.md](verification.md).

## Eligibility

Only an offer containing an eligibility-changing fact reevaluates observed
contracts in the same snapshot. The eligibility-changing facts are `bind`,
`amend`, and `claimed` from an explicit placement request. The offer appends
every newly eligible `bound` fact before dependent facts, in one ordered atomic
offer. A verification fact does not change eligibility.

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
