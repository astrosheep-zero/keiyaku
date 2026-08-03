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
semantic attempt, mechanically rebuilding on unrelated carrier movement. Any
watched contract, evidence path, or verb-owned ref change returns a typed
conflict instead of re-deciding policy.

`protocol/run.ts` owns retry and accepted-attempt recognition. It must never
branch on verb kind. Each verb owns one pure decision function.

## Derived State

Workspace files, delivery refs, rendered contract documents, and task
settlement are effects. One idempotent reconcile computes desired minus actual.
Failure to reconcile cannot reverse an accepted journal transaction.
