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
the current phase, journal head, effective body, current delivery endpoint,
current petition and terminal entries, and inline evidence entries. Historical
seat and delivery collections are projections over journal entries, never
parallel state fields.

Admission mechanics never enter entry payloads. Membership grouping belongs
to an `Offer`, accepted-attempt identity belongs to entry ULIDs, and CAS
old values belong to ref operations. In particular, `seal` has no owner
payload, `claim` names only its petition, and `forfeit` stores no final ref
coordinate.

## Admission

An offer contains journal fact appends, evidence writes, expected contract
heads, and verb-owned ref operations. The admission kernel owns raw Git
object construction and one atomic `update-ref` operation. It performs one
semantic attempt. It mechanically rebuilds only after a clean race confirms
actual unrelated carrier movement. Rebuilds are progress-coupled and unbounded:
every rebuild follows one carrier ref advance. Any watched contract, evidence
path, or verb-owned ref change returns a typed outcome; a clean race without a
carrier move rethrows its original error.

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
observed there. Ref premises are prepared by a verb's impure shell, so
`ref-moved` returns to that shell for re-observe, reprepare, and rerun.
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
`reconcileBind` has nothing to do. The first verb that installs delivery owns
the delivery coordinate and stale-ref admission; its reconcile must align refs
and worktree to the journaled delivery head and must never follow a newer
target.
