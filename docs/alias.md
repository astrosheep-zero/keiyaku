# Alias

Alias is the sole authority for movable human selectors that point at Akuma
identities. It is world-local convenience, not Akuma identity, lineage,
Dispatch, lifecycle, or a durable property of an Akuma.

## Resource

One exact Akuma world has one file:

```text
<world>/.keiyaku/akuma/alias.json
```

Its current canonical shape is:

```ts
type AliasFile = Readonly<{
  version: 1
  aliases: Readonly<Record<AkumaAlias, AkuId>>
}>
```

The file is one canonical JSON line. Keys are sorted by byte order and every
selector and complete AkuId is validated through its identity owner. A missing
file is an empty map. A malformed, non-canonical, or non-current file throws
`AuthorityCorruptionError`; it is never partly read or silently repaired.
Alias solely owns this path, codec, read, and move operation.
The selector grammar itself remains solely in [model.md](model.md).

Alias reads and resolution return Promises and fulfill only after the complete
authority file has been read and decoded. A missing-file observation is the
empty map; corruption remains a rejected operation. Alias has no synchronous
read wrapper or cached registry.

An alias move replaces or adds exactly one mapping and returns its previous
target, if any. There is no append log, database copy, deletion verb, alias
inheritance, reverse index, existence probe, or sweep. The target is a complete
AkuId; the operation does not inspect that Akuma's heart.

## Concurrency And Durability

Writers serialize on one existing coordination primitive:

```text
<world>/.keiyaku/locks/akuma-alias.sqlite
```

One SQLite `BEGIN IMMEDIATE` transaction lock covers the complete JSON read,
single mapping update, and durable file replacement. The writer waits for the
lock rather than publishing from a stale snapshot. Replacement uses a unique
same-directory temporary file, file fsync, rename, and parent-directory fsync.
The lock is process coordination only and contains no Alias fact.

The coordination lock exposes an async acquisition boundary. Its internal
`DatabaseSync` use is limited to the bounded one-owner SQLite transaction that
attempts acquisition and establishes custody; no external filesystem
observation occurs inside that synchronous section. Release closes that held
custody synchronously because it contains no wait or observation.

Readers do not take the writer lock. Atomic rename gives them either the old
complete file or the new complete file; they never observe an in-place partial
write. Independent writers therefore preserve each other's mappings without a
second in-memory or SQLite authority.

The writer awaits directory preparation and the complete locked mutation in
serial order. The shared durable-file owner may use synchronous
`open`/`write`/`fsync`/`rename`/directory-`fsync` only inside its indivisible
same-directory replacement commit section; all Alias observation around that
section is asynchronous.

## Boundary

Alias imports only the shared selector parser, Akuma identity parser,
`AuthorityCorruptionError`, durable-file replacement, and the SQLite
transaction lock. Akuma, Dispatch, Contract, Task, Git, Settings, and CLI do
not own or persist Alias state. The Library may sequence a move after Akuma
birth; a later Alias failure does not erase the born Akuma or any published
Dispatch.
