# Dispatch

Dispatch is the sole Akuma-to-Contract association authority. It connects two
otherwise independent products: Akuma neither stores Contract identity nor
reads Dispatch, and Contract lifecycle neither reads nor changes Dispatch. A
Dispatch fact says only which Contract an Akuma was sent for. It has no World
identity, global registry, reverse index, or cross-repository meaning.

## Immutable Authority

An Akuma has at most one immutable Dispatch fact. Dispatch alone owns its
private Git storage, canonical decoding, targeted and complete reads, and
publication. A complete read uses one call-scoped Git observation and returns
only Dispatch facts selected from it; product readers, not Git, judge their
canonicality and duplication. Corrupt, missing, malformed, or duplicate durable
Dispatch authority is `AuthorityCorruptionError`, never a partly repaired read
or cache entry.

Contract history may compose Dispatch facts from that same frozen observation.
Membership is exact Contract identity. This projection creates no Contract
back-pointer, Akuma-history expansion, second timestamp, or reverse index.
Failed publication creates no Dispatch event.

## Publication

Dispatch publishes through Git's shared private-state custody and its atomic
currentness/read-back law. The same Akuma-to-Contract association is idempotent
and keeps its original recorded time. A different Contract for that Akuma is a
typed conflict and never rewrites authority. An uncertain publication is judged
only by durable read-back; Dispatch adds no private retry loop, product lock,
contention result, or Git-prose parser.

Library may sequence Dispatch after Akuma birth or fork and expose its outcome.
A later Dispatch failure never rolls back a born Akuma or another published
fact.

## Boundary

Git carries Dispatch bytes without decoding them. Dispatch depends only on the
identity owners and Git's private-state capability. Core, protocol, Contract,
Task, Alias, Settings, and Akuma do not gain Dispatch storage or a generic
association/event mechanism.
