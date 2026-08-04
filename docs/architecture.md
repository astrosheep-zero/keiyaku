# Architecture

Status: bootstrap authority.

## One Chain Of Truth

The durable graph is:

```text
refs/heads/keiyaku-state
  -> carrier commit
    -> tree
      -> contracts/<contract-id>.jsonl
      -> contracts/<contract-id>/evidence/<entry-ulid>/<seq>-<kind>
      -> admission/**
      -> meta/format.json
```

The carrier branch is a physical Merkle map, not a repository event log. A
contract's `ContractHead` is its journal blob OID. Unrelated carrier movement
does not change that contract.

## Facts

Lifecycle facts required by fold and admission are inline journal entries.
Unbounded reports, transcripts, patches, and artifacts are evidence blobs.
Journal decisions never resolve evidence blobs.

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
A definite moved or occupied outcome invalidates the old decision: the protocol
re-observes one snapshot, invokes the pure decision again, and uses fresh entry
ULIDs.
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
