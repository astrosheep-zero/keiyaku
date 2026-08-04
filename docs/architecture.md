# Architecture

Status: bootstrap authority.

## One Chain Of Truth

The durable graph is:

```text
refs/heads/keiyaku-state
  -> carrier commit
    -> tree
      -> contracts/<machine-contract>.jsonl
      -> contracts/<machine-contract>/evidence/<entry-ulid>/<seq>-<kind>
      -> admission/**
      -> meta/format.json
```

The carrier branch is a physical Merkle map, not a repository event log. A
contract's `ContractHead` is its journal blob OID. Unrelated carrier movement
does not change that contract.

## Identity Coordinates

Public identities use the closed registry below. Slash is the only type bit:
parsing dispatches an exact registered prefix, never a payload shape or a
pairwise-disjointness predicate.

| Prefix | Public grammar |
| --- | --- |
| `aku/` | `aku/<human-profile>` or `aku/<human-profile>/<lower-hex8>` |
| `kei/` | `kei/<machine-contract>` |
| `task/` | `task/<human-ns>/<human-local-id>` |
| `resp/` | `resp/<machine-artifact>` |

A human-named segment and movable reference match
`/^(?:[a-z0-9\-]|\p{RGI_Emoji})+$/v`: nonempty lowercase ASCII letters,
digits, and hyphens mixed with Unicode RGI emoji sequences, with no
whitespace. Their identity is exact bytes: there is no Unicode normalization
or visual-confusable deduplication. Machine segments match
`[a-z0-9][a-z0-9-]*`; a projection suffix is lower hex8; and a `resp` payload
uses the machine-segment grammar. A task has exactly its two payload segments,
human namespace and local ID; there is no hub form.

`@` is input-only. After it is removed, a slash is a full registered identity
and no slash is a context-resolved movable reference matching the human rule.
Neither `@` nor a movable reference is persisted as a durable fact coordinate.

Journal facts persist the full `kei/<machine-contract>` coordinate. Carrier
paths privately strip `kei/`, yielding `contracts/<machine-contract>.jsonl`
and `contracts/<machine-contract>/evidence/**`; no path is parsed back into a
public identity. This is a clean format cut: unprefixed contract IDs are
rejected, with no legacy reader, classifier, or migration. `repository.ts`
writes the exact format stamp on first admission and checks it on every
nonempty carrier read.

## Facts

Lifecycle facts required by fold and admission are inline journal entries.
Unbounded reports, transcripts, patches, and artifacts are evidence blobs.
Evidence blob bytes never enter fold input or lifecycle judgment; journaled
evidence facts remain ordinary fold input.

An evidence path is write-once. Its journal `EvidenceRef` names the entry,
sequence, kind, and blob OID; the path is derived rather than persisted.
Journal append and evidence bytes publish in one carrier commit.

`ContractState` is a fold, not another persisted authority. It contains only
the current phase, journal head, effective body, current `delivery` with
`target`, `base`, and `head`, current petition, a current approval `ReviewEntry`
pointer, terminal entries, and inline evidence entries. The approval is not a
search over historical evidence, and `approved` is not a lifecycle phase.
Historical delivery collections are projections over journal entries, never
parallel state fields.

Admission mechanics never enter entry payloads. Membership grouping belongs
to an `Offer`, accepted-attempt identity belongs to entry ULIDs, and CAS old
values belong to `RefOperation`. `claim` is the sole verb that carries a
`RefOperation`. `ClaimData` is `{ petition }`, and that operation moves the
target from `petition.expectedPredecessor` to `petition.candidate`. `seal` has
no owner payload, and `forfeit` stores no final ref coordinate.

## Admission

An offer contains journal fact appends, evidence writes, expected contract
heads, and a `RefOperation` only for `claim`; that operation has the petition
fact's `expectedPredecessor` and `candidate` as its old and new values. The
admission kernel owns raw Git object construction and one atomic `update-ref`
operation. It performs one semantic attempt. It mechanically rebuilds only
after a clean race confirms actual unrelated carrier movement. Rebuilds are
progress-coupled and unbounded: every rebuild follows one carrier ref advance.
Any watched contract, evidence path, or `claim` `RefOperation` change returns
a typed outcome; a clean race without a carrier move rethrows its original
error.

Admissions are closed: accepted, head-moved, evidence-occupied, ref-moved, or
unknown. Validation, codec, corruption, and
ordinary Git errors before atomic ref publication remain exceptions. A clean
`update-ref` abort is a definite non-publication. Only a process-level failure
after the ref subprocess starts, where its exit cannot be known, is typed
`unknown`.

Every semantic decision and acceptance check uses exactly one carrier snapshot.
Multi-contract observation reads the carrier once and folds every journal from
that tree. An attempted append is accepted only when every planned entry is
present under its contract and its canonical bytes match exactly. Entry ULIDs
are coordinates, not a second authority. The planned entries are the attempt
identity; an `Offer` has no separate attempt ID.

`protocol/run.ts` owns semantic retry and never branches on verb kind.
A definite `head-moved` or `evidence-occupied` outcome invalidates the old decision: the protocol
re-observes one snapshot, invokes the pure decision again, and uses fresh entry
ULIDs.
Contract-head movement retries inside the runner because contract state is
observed there. `claim` has no shell preparation: its `RefOperation` premise
comes from the petition fact. A moved claim premise returns terminal
`petition-stale`, with no claim retry or reprepare; the actor petitions anew
from fresh observation with fresh ULIDs.
`forfeit` and `claim` race through journal-head admission without intent
gating. Both pass the one adjudicator; the loser observes contract-head
movement, redecides against the terminal state, and refuses typed.
Unknown has one identity-reuse case: when all planned entries are absent
and expected contract heads are unchanged, it resubmits the same offer. Otherwise
accepted-attempt recognition follows durable facts:

- all planned entries match canonically: report accepted;
- none appear and expected heads moved: make a fresh semantic decision;
- an ULID appears with different canonical content: surface the collision and
  make a fresh semantic decision.

A partial match of a multi-entry attempt is impossible under atomic publication
and therefore fails closed as corrupted authority.

Process recovery needs no attempt ledger. A new process observes durable facts
and runs the pure decision from them.

Each verb owns one pure decision function.

## Derived State

Workspace files, delivery refs, rendered contract documents, and task
settlement are effects. One idempotent reconcile computes desired minus actual.
Failure to reconcile cannot reverse an accepted journal admission.

`bind` is declaration only: its body-only `BindEntry` establishes no base or
target world premise, delivery coordinate, ref operation, or worktree, and
`reconcileBind` has nothing to do.

## Delivery

`open` is the first delivery installation. `OpenData` is `{ target, base }`,
where `target` is the external Git ref name as a plain string, not a public
identity. Fold records `state.delivery = { target, base, head: base }`. Only
`open` installs delivery; `renew` and `seal` refuse when delivery is absent.
No sealed state has `delivery == null`. `RenewData` is
`{ newBase, oldHead, newHead }`: it preserves `state.delivery.target`, requires
`oldHead == state.delivery.head`, then records `newBase` as the base and
`newHead` as the head.

The target ref name, delivery base/head, and candidate OID are journal facts.
The delivery-ref name and worktree path are private deterministic conventions
derived from contract identity, not persisted facts. `open` and `renew` carry
no `RefOperation`; their OIDs are shell-observed values and admission is
carrier CAS only. `claim` alone carries a `RefOperation`.

`PetitionData` is exactly `{ expectedPredecessor, deliveryHead, candidate }`.
It has no `intent`, `oath`, `seat`, forfeit-petition, or payload variants. One
entry kind carries one verb meaning. The candidate is shell-prepared before
`decide`; a merge conflict is a typed petition refusal, not an admission
outcome. Candidate commits use a deterministic merge strategy, the petition
actor and `at` for author/committer identity and timestamp, and a fixed message
format. Equal inputs produce byte-identical content and the same OID.

There is no candidate ref or retention rule. A collected candidate is
re-derived from the petition fact and retained inputs: `deliveryHead` remains
reachable through the reconcile-maintained delivery ref, and
`expectedPredecessor` remains in target history. Claim lands exactly
`petition.candidate`; there is no predicted/realized duality.

Contract state holds a current approval `ReviewEntry` pointer, not a search over
historical evidence. An approved review sets it; a changes-requested review,
amend, renew, new petition, and terminal settlement clear it as applicable.
`approved` is not a lifecycle phase. The approval carries `{ reviewedHead }`.
Claim refuses unless
`approval.reviewedHead == petition.deliveryHead`; a renew that changes the
delivery head requires re-review. `ClaimData` remains `{ petition }`: it
references the petition coordinates rather than copying them. Its sole
`RefOperation` moves target `petition.expectedPredecessor` to
`petition.candidate`. Because this premise was produced by the petition fact,
claim has no shell preparation. A moved premise is terminal `petition-stale`:
there is no claim retry or reprepare, and the actor petitions anew from fresh
observation with fresh ULIDs.

`forfeit` refuses only in terminal states, `claimed` and `forfeited`. Every
nonterminal lifecycle state is forfeitable, including after a claim petition
exists and after approval. Its race with claim uses journal-head admission: both
pass the one adjudicator; the loser observes contract-head movement, redecides
against the terminal state, and refuses typed.

Reconcile owns ref alignment. `open` creates the conventional delivery ref at
head and materializes the conventional worktree; `renew` moves that ref to
`newHead` and refreshes the worktree; `petition` has no reconcile effect; and
`claim` and `forfeit` delete the delivery ref and worktree as settlement cleanup
when delivery exists. Each effect reconstructs from accepted facts plus fresh
observation, is idempotent from null handoff, and never follows a newer target.

The current delivery implementation slice is schema/fold work plus pure
`open` and `renew` owners and tests. Petition and claim owners are the next
slice; claim then exercises the sole target `RefOperation` and terminal
`petition-stale` path end to end.

Do not add queue/seat machinery, predicted-commit duality, candidate refs or
retention, verification-run gating, persisted worktree paths or delivery-ref
names, target-pin `RefOperation`s on `open` or `renew`, or intent/kind-
discriminated payload variants inside one entry type. One entry kind carries one
verb meaning.
