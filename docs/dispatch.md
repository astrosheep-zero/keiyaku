# Dispatch

Dispatch is the sole Akuma-to-Contract association authority. It is a concrete
integration owner between otherwise independent products: Akuma neither knows
nor stores Contract identity, and Contract lifecycle neither reads nor changes
Dispatch. A Dispatch fact says only which Contract an Akuma was sent for.

## Authority

There is at most one immutable Dispatch fact for a complete `AkuId`:

```ts
type Dispatch = Readonly<{
  akuId: AkuId
  contractId: ContractId
  dispatchedAt: string
}>
```

The fact lives in the existing private Git state map at:

```text
dispatch/<sha256(AkuId)>.json
```

The fixed digest bounds tree shape. Canonical one-line JSON retains the
complete identities and timestamp, and the reader verifies the AkuId digest
against the path. The current Git format marker governs this record; there is
no record-local compatibility version, alternate path, reverse index, Akuma
back-pointer, Contract back-pointer, update, delete, or reassignment.

Dispatch is the sole owner of its path, codec, targeted read, complete read,
and immutable publication owner. A targeted read is proportional to one fact;
a complete read scans the Dispatch subtree once and returns facts ordered by
AkuId bytes. Malformed paths, non-canonical bytes, invalid identities,
unparseable timestamps, and duplicate authority are
`AuthorityCorruptionError`.

## Publication

Publication observes the current private Git root, writes one blob and tree,
and moves only `refs/heads/keiyaku-state` by CAS. It uses the existing Git
format marker when establishing an empty private root. A same-AkuId,
same-Contract fact is idempotent success and preserves the original
`dispatchedAt`; a same-AkuId, different-Contract fact is a typed conflict and
never changes authority.

CAS movement is retried from fresh observation for at most three attempts. A
Git result whose publication is unknown is always classified by authoritative
read-back. Read-back of the intended canonical fact is success; read-back of a
different Contract is conflict; absence permits another attempt. Exhausted
contention and a known publication failure are typed results, not invented
facts or naked success. No layer parses Git diagnostic prose.

```ts
type DispatchFailure =
  | Readonly<{ kind: "conflict"; current: Dispatch }>
  | Readonly<{ kind: "contention" }>
  | Readonly<{ kind: "publication-failed"; diagnostic: string }>

type DispatchPublication =
  | Readonly<{ kind: "dispatched"; dispatch: Dispatch }>
  | Readonly<{ kind: "failed"; failure: DispatchFailure }>
```

The Library may sequence this concrete operation after Akuma birth or fork.
It may expose the result but never rewrites, retries beyond this owner, or
rolls back an already born Akuma.

## Boundary

Dispatch imports only the Akuma identity parser, Contract identity parser,
`AuthorityCorruptionError`, and concrete Git primitives. Git treats its bytes
as ordinary private-tree bytes and does not decode Dispatch. Neither Akuma nor
core, protocol, Task, Alias, or Settings imports Dispatch. There is no generic
association registry, event bus, VCS backend, or provider interface.
