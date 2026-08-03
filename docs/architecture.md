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

Transaction mechanics never enter entry payloads. Membership grouping belongs
to `TransactionPlan`, accepted-attempt identity belongs to entry ULIDs, and CAS
old values belong to ref operations. In particular, `seal` has no owner
payload, `claim` names only its petition, and `forfeit` stores no final ref
coordinate.

## Transactions

A transaction plan contains contract appends, evidence writes, expected
contract heads, and verb-owned ref operations. The facts log owns raw Git
object construction and one atomic `update-ref` transaction. It performs one
semantic attempt. It mechanically rebuilds only on unrelated carrier movement,
within a bounded retry budget supplied as mechanics options rather than plan
data. Exhaustion returns typed `contention`; it never loops forever. Any watched
contract, evidence path, or verb-owned ref change returns a typed conflict.

Facts outcomes are closed: committed, contract conflict, evidence conflict,
ref conflict, contention, or indeterminate. Validation, codec, corruption, and
ordinary Git errors before atomic ref publication remain exceptions. A clean
`update-ref` abort is a definite non-publication. Only a process-level failure
after the ref subprocess starts, where its exit cannot be known, is typed
`indeterminate`.

Every semantic decision and acceptance check uses exactly one carrier snapshot.
Multi-contract observation reads the carrier once and folds every journal from
that tree. An attempted append is accepted only when every planned entry is
present under its contract and its canonical bytes match exactly. Entry ULIDs
are coordinates, not a second authority. The planned entries are the attempt
identity; `TransactionPlan` has no separate attempt ID.

`protocol/run.ts` owns bounded semantic retry and never branches on verb kind.
A definite conflict invalidates the old decision: the protocol re-observes one
snapshot, invokes the pure decision again, and uses fresh entry ULIDs.
Contention resubmits the byte-identical plan with the same identities.
Indeterminate is the only outcome that permits accepted-attempt recognition:

- all planned entries match canonically: report committed;
- none appear and expected contract heads are unchanged: resubmit the same plan;
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
Failure to reconcile cannot reverse an accepted journal transaction.
